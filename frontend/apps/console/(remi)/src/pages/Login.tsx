import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useAuthStore } from "../stores/auth";
import { listSsoProviders, ssoLoginUrl, type SsoProviderInfo } from "../api/client";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { LogIn, ShieldCheck } from "lucide-react";

export function Login() {
  const { user, ssoConfigured, initialized, loading, fetchMe } = useAuthStore();
  const [, navigate] = useHashLocation();
  const [location] = useLocation();
  const [providers, setProviders] = useState<SsoProviderInfo[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  useEffect(() => {
    listSsoProviders()
      .then((p) => {
        setProviders(p);
        setProvidersLoaded(true);
      })
      .catch(() => setProvidersLoaded(true));
  }, []);

  useEffect(() => {
    if (initialized && user) navigate("/");
  }, [initialized, user, navigate]);

  const handleLogin = (providerId: string) => {
    const next = location === "/login" ? "/" : location;
    const nextHash = next === "/" ? "/" : `/#${next}`;
    window.location.href = ssoLoginUrl(providerId, nextHash);
  };

  // Auto-redirect when only ONE provider is configured — skip the picker
  // and bounce straight to the IdP. This is what most single-provider
  // setups expect (no extra click).
  const [autoRedirected, setAutoRedirected] = useState(false);
  useEffect(() => {
    if (
      providersLoaded &&
      providers.length === 1 &&
      initialized &&
      !user &&
      !autoRedirected
    ) {
      setAutoRedirected(true);
      handleLogin(providers[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providersLoaded, providers, initialized, user]);

  if (!initialized || loading || !providersLoaded || autoRedirected) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">
          {autoRedirected ? "Redirecting to login…" : "Loading…"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardContent className="p-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <ShieldCheck className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="text-lg font-semibold">Sign in to Remi</div>
              <div className="text-xs text-muted-foreground">
                Choose an identity provider
              </div>
            </div>
          </div>

          {!ssoConfigured || providers.length === 0 ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              No SSO provider configured. Add one via Dashboard{" "}
              <code>/sso-providers</code> (or seed via <code>remi.toml [sso]</code>{" "}
              + restart).
            </div>
          ) : (
            <div className="space-y-2">
              {providers.map((p) => (
                <Button
                  key={p.id}
                  onClick={() => handleLogin(p.id)}
                  className="w-full justify-start"
                  size="lg"
                  variant="outline"
                >
                  <span className="mr-2 inline-flex h-5 w-5 items-center justify-center">
                    {p.icon ?? <LogIn className="h-4 w-4" />}
                  </span>
                  Continue with {p.name}
                </Button>
              ))}
            </div>
          )}

          <div className="mt-6 border-t border-border pt-4 text-[10px] uppercase tracking-wider text-muted-foreground">
            <div>Auth via Remi SSO plugin</div>
            <div className="mt-1">
              {providers.length} provider{providers.length === 1 ? "" : "s"} available
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
