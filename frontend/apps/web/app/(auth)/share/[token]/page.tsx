"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuthStore } from "@multiremi/core/auth";
import { paths } from "@multiremi/core/paths";
import { SharedIssuePage } from "@multiremi/views/share";

export default function SharedIssueRoutePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const isLoading = useAuthStore((state) => state.isLoading);

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace(
        `${paths.login()}?next=${encodeURIComponent(paths.share(params.token))}`,
      );
    }
  }, [isLoading, params.token, router, user]);

  if (isLoading || !user) return null;
  return <SharedIssuePage token={params.token} />;
}
