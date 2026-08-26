import { lookup as dnsLookup } from "node:dns/promises";

export interface RelayHttpResponse {
  status: number;
  text: string;
}

export type RelayHttpRequest = (
  url: string,
  init: RequestInit,
  options?: { timeoutMs?: number; maxBodyBytes?: number },
) => Promise<RelayHttpResponse>;

/** True if the (possibly IPv4-mapped-IPv6) address is loopback/private/link-local/metadata. */
export function isPrivateIp(ip: string): boolean {
  let addr = ip.toLowerCase();
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) addr = mapped[1];
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  return addr === "::1" || addr === "::" || /^fe[89ab]/.test(addr) || addr.startsWith("fc") || addr.startsWith("fd");
}

/** Resolve the host and reject if any address is internal. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const results = await dnsLookup(hostname, { all: true });
  if (results.length === 0) throw new Error("gateway host did not resolve");
  for (const { address } of results) {
    if (isPrivateIp(address)) throw new Error("gateway host resolves to a private address");
  }
}

/** Read a response while enforcing the cap, rather than after buffering it. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new Error("gateway response too large");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error("gateway response too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Shared relay transport with SSRF checks, no redirects, timeout, and a body cap. */
export const publicRelayHttpRequest: RelayHttpRequest = async (url, init, options = {}) => {
  const parsed = new URL(url);
  await assertPublicHost(parsed.hostname);
  const res = await fetch(parsed, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  return {
    status: res.status,
    text: await readCapped(res, options.maxBodyBytes ?? 1_000_000),
  };
};
