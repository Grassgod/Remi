"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { sanitizeNextUrl, useAuthStore } from "@multiremi/core/auth";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import { paths, resolvePostAuthDestination } from "@multiremi/core/paths";
import { api } from "@multiremi/core/api";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@multiremi/ui/components/ui/card";
import { Loader2 } from "lucide-react";

// Feishu (Lark) SSO callback. Feishu redirects here with ?code=&state= after
// the user authorizes. We exchange the code for a session, then route to the
// carried `next:` destination (invite links survive the round-trip), pending
// invitations, or the resolved post-auth destination.
function CallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const loginWithLark = useAuthStore((s) => s.loginWithLark);
  const [error, setError] = useState("");

  useEffect(() => {
    const code = searchParams.get("code");
    if (!code) {
      setError("Missing authorization code");
      return;
    }

    const errorParam = searchParams.get("error");
    if (errorParam) {
      setError(errorParam === "access_denied" ? "Access denied" : errorParam);
      return;
    }

    const state = searchParams.get("state") || "";
    const nextPart = state.split(",").find((p) => p.startsWith("next:"));
    // Strip "next:" prefix, then drop anything that isn't a safe relative path
    // so an attacker-controlled `state=next:https://evil` cannot redirect here.
    const nextUrl = sanitizeNextUrl(nextPart ? nextPart.slice(5) : null);

    const redirectUri = `${window.location.origin}/auth/callback`;

    loginWithLark(code, redirectUri)
      .then(async (loggedInUser) => {
        const wsList = await api.listWorkspaces();
        qc.setQueryData(workspaceKeys.list(), wsList);
        const onboarded = loggedInUser.onboarded_at != null;

        // 1. nextUrl wins: a `next=/invite/<id>` always survives the SSO
        //    round-trip — honor exactly the destination the user clicked.
        if (nextUrl) {
          router.push(nextUrl);
          return;
        }

        // 2. Un-onboarded users may have pending invitations on their email.
        //    Route them to the batch /invitations page so they can auto-join
        //    (invitations are keyed by the company email Feishu returns).
        if (!onboarded) {
          try {
            const invites = await api.listMyInvitations();
            if (invites.length > 0) {
              qc.setQueryData(workspaceKeys.myInvitations(), invites);
              router.push(paths.invitations());
              return;
            }
          } catch {
            // Non-fatal: fall through to the normal post-auth destination.
          }
        }

        // 3. Default: onboarding for first-timers, first workspace for
        //    returning users, /workspaces/new for onboarded users with none.
        router.push(resolvePostAuthDestination(wsList, onboarded));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Login failed");
      });
  }, [searchParams, loginWithLark, router, qc]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Login Failed</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <a href={paths.login()} className="text-primary underline-offset-4 hover:underline">
              Back to login
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Signing in...</CardTitle>
          <CardDescription>Please wait while we complete your login</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackContent />
    </Suspense>
  );
}
