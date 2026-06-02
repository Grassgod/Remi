import { useEffect, useState } from "react";
import { LogIn, ShieldCheck } from "lucide-react";
import { listSsoProviders, ssoLoginUrl, type SsoProviderInfo } from "../api/client";

/**
 * Login entry for the public Board bundle (board.html), which has no Login
 * page of its own. `next` is the current Board path (a real URL path); the SSO
 * callback redirects straight back to it after a successful sign-in.
 */
export function BoardLoginPrompt({ next }: { next: string }) {
  const [providers, setProviders] = useState<SsoProviderInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    listSsoProviders()
      .then((p) => {
        setProviders(p);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const login = (providerId: string) => {
    setRedirecting(true);
    window.location.href = ssoLoginUrl(providerId, next);
  };

  // Single provider → skip the picker and bounce straight to the IdP.
  useEffect(() => {
    if (loaded && providers.length === 1 && !redirecting) {
      login(providers[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, providers]);

  if (!loaded || redirecting || providers.length === 1) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[#fafafa]">
        <div className="text-sm text-gray-500">
          {redirecting || providers.length === 1 ? "Redirecting to login…" : "Loading…"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-[#fafafa] px-4">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
            <ShieldCheck className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <div className="text-lg font-semibold text-gray-900">Sign in to continue</div>
            <div className="text-xs text-gray-500">This board requires a login</div>
          </div>
        </div>

        {providers.length === 0 ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-600">
            No SSO provider configured.
          </div>
        ) : (
          <div className="space-y-2">
            {providers.map((p) => (
              <button
                key={p.id}
                onClick={() => login(p.id)}
                className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                <span className="inline-flex h-5 w-5 items-center justify-center">
                  {p.icon ?? <LogIn className="h-4 w-4" />}
                </span>
                Continue with {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
