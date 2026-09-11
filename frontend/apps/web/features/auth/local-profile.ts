/** Local profile login is an explicit UI option; API token validation still applies. */
export function allowsLocalTokenLogin(profile: string | undefined, hostname: string): boolean {
  return (profile === "dev" || profile === "stable")
    && (hostname === "localhost" || hostname === "127.0.0.1");
}

/** Stable also permits its configured LAN host; the API independently gates login. */
export function allowsPasswordLogin(profile: string | undefined, hostname: string, siteUrl?: string): boolean {
  if (allowsLocalTokenLogin(profile, hostname)) return true;
  if (profile !== "stable" || !siteUrl || !hostname) return false;
  try {
    const site = new URL(siteUrl);
    return (site.protocol === "http:" || site.protocol === "https:") && site.hostname === hostname;
  } catch {
    return false;
  }
}
