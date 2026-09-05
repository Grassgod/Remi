import { readFile, stat } from "node:fs/promises";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup as dnsLookupPromise } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { extname } from "node:path";
import type {
  MarkdownImageResolver,
  MarkdownImageSource,
} from "@shared/feishu-markdown-images.js";
import { isFeishuImageKey } from "@shared/feishu-markdown-images.js";

export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEISHU_IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
const FEISHU_IMAGE_MAX_REDIRECTS = 3;

export interface LoadedFeishuImage {
  buffer: Buffer;
  contentType: string;
  fileName?: string;
}

export type FeishuAttachmentImageLoader = (
  source: Extract<MarkdownImageSource, { kind: "attachment" }>,
) => Promise<LoadedFeishuImage | null>;

export type FeishuImageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type FeishuImageHostGuard = (hostname: string) => Promise<void>;
export type FeishuImageDnsLookup = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface FeishuImageSourceAllowlist {
  attachment?: boolean;
  local?: boolean;
  http?: boolean;
}

export interface FeishuImageResolverOptions {
  uploadImage: (image: LoadedFeishuImage) => Promise<string | null | undefined>;
  loadAttachment?: FeishuAttachmentImageLoader;
  fetchFn?: FeishuImageFetch;
  maxBytes?: number;
  timeoutMs?: number;
  assertRemoteHost?: FeishuImageHostGuard;
  lookupFn?: FeishuImageDnsLookup;
  cache?: Map<string, Promise<string | null>>;
  /** Omitted entries preserve the existing behavior and remain enabled. */
  allow?: FeishuImageSourceAllowlist;
}

export function createFeishuImageResolver(options: FeishuImageResolverOptions): MarkdownImageResolver {
  const cache = options.cache ?? new Map<string, Promise<string | null>>();
  return async (source) => {
    if (source.kind === "feishu") return source.imageKey;
    if (!isFeishuImageSourceAllowed(source, options.allow)) return null;
    const existing = cache.get(source.src);
    if (existing) return existing;
    const pending = (async () => {
      const image = await loadFeishuImage(source, options);
      if (!image) return null;
      const imageKey = (await options.uploadImage(image))?.trim() ?? "";
      return isFeishuImageKey(imageKey) ? imageKey : null;
    })().catch(() => null);
    cache.set(source.src, pending);
    return pending;
  };
}

export async function loadFeishuImage(
  source: MarkdownImageSource,
  options: Pick<
    FeishuImageResolverOptions,
    "loadAttachment" | "fetchFn" | "maxBytes" | "timeoutMs" | "assertRemoteHost" | "lookupFn" | "allow"
  > = {},
): Promise<LoadedFeishuImage | null> {
  const maxBytes = positiveLimit(options.maxBytes, FEISHU_IMAGE_MAX_BYTES);
  if (source.kind === "feishu" || source.kind === "unsupported") return null;
  if (source.kind === "attachment") {
    if (!isFeishuImageSourceAllowed(source, options.allow)) return null;
    if (!options.loadAttachment) return null;
    const loaded = await options.loadAttachment(source);
    return loaded ? validateFeishuImage(loaded, maxBytes) : null;
  }
  if (source.kind === "local") {
    if (!isFeishuImageSourceAllowed(source, options.allow)) return null;
    const info = await stat(source.filePath);
    if (!info.isFile()) throw new Error("image source is not a file");
    if (info.size > maxBytes) throw new Error("image exceeds the Feishu 10MB limit");
    return validateFeishuImage({
      buffer: await readFile(source.filePath),
      contentType: imageContentTypeFromFilename(source.filePath),
      fileName: source.name,
    }, maxBytes);
  }
  if (!isFeishuImageSourceAllowed(source, options.allow)) return null;
  return fetchImageWithTimeout(
    source.url,
    options.fetchFn,
    positiveLimit(options.timeoutMs, FEISHU_IMAGE_DOWNLOAD_TIMEOUT_MS),
    source.name,
    maxBytes,
    options.assertRemoteHost,
    options.lookupFn ?? dnsLookup,
  );
}

function isFeishuImageSourceAllowed(
  source: MarkdownImageSource,
  allow: FeishuImageSourceAllowlist | undefined,
): boolean {
  if (source.kind === "attachment") return allow?.attachment !== false;
  if (source.kind === "local") return allow?.local !== false;
  if (source.kind === "http") return allow?.http !== false;
  return source.kind === "feishu";
}

export function validateFeishuImage(image: LoadedFeishuImage, maxBytes = FEISHU_IMAGE_MAX_BYTES): LoadedFeishuImage {
  const contentType = normalizeContentType(image.contentType);
  if (!contentType.startsWith("image/")) throw new Error("image source has a non-image content type");
  if (image.buffer.byteLength > maxBytes) throw new Error("image exceeds the Feishu 10MB limit");
  return { ...image, contentType };
}

export async function responseToFeishuImage(
  response: Response,
  fileName?: string,
  maxBytes = FEISHU_IMAGE_MAX_BYTES,
): Promise<LoadedFeishuImage> {
  const contentType = normalizeContentType(response.headers.get("content-type") ?? "");
  if (!contentType.startsWith("image/")) throw new Error("image source has a non-image content type");
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new Error("image exceeds the Feishu 10MB limit");
  }
  const buffer = await readResponseWithinLimit(response, maxBytes);
  return validateFeishuImage({ buffer, contentType, fileName }, maxBytes);
}

async function fetchImageWithTimeout(
  url: string,
  fetchFn: FeishuImageFetch | undefined,
  timeoutMs: number,
  fileName: string,
  maxBytes: number,
  assertRemoteHost: FeishuImageHostGuard | undefined,
  lookupFn: FeishuImageDnsLookup,
): Promise<LoadedFeishuImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = new URL(url);
    for (let redirects = 0; redirects <= FEISHU_IMAGE_MAX_REDIRECTS; redirects += 1) {
      if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
        throw new Error("image redirect used an unsupported protocol");
      }
      const response = fetchFn
        ? await fetchImageWithInjectedFetch(
            currentUrl,
            fetchFn,
            controller.signal,
            assertRemoteHost ?? assertPublicFeishuImageHost,
          )
        : await requestFeishuImage(currentUrl, controller.signal, lookupFn);
      const location = redirectLocation(response);
      if (location) {
        await response.body?.cancel().catch(() => undefined);
        if (redirects === FEISHU_IMAGE_MAX_REDIRECTS) throw new Error("image download exceeded redirect limit");
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      if (!response.ok) throw new Error(`image download returned HTTP ${response.status}`);
      return await responseToFeishuImage(response, fileName, maxBytes);
    }
    throw new Error("image download exceeded redirect limit");
  } finally {
    clearTimeout(timer);
  }
}

export async function assertPublicFeishuImageHost(hostname: string): Promise<void> {
  assertGlobalFeishuImageAddresses(
    await dnsLookupPromise(normalizeHostname(hostname), { all: true }),
  );
}

function fetchImageWithInjectedFetch(
  url: URL,
  fetchFn: FeishuImageFetch,
  signal: AbortSignal,
  assertRemoteHost: FeishuImageHostGuard,
): Promise<Response> {
  return assertRemoteHost(normalizeHostname(url.hostname))
    .then(() => fetchFn(url, { signal, redirect: "manual" }));
}

function requestFeishuImage(
  url: URL,
  signal: AbortSignal,
  lookupFn: FeishuImageDnsLookup,
): Promise<Response> {
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    assertGlobalFeishuImageAddresses([{ address: hostname, family: literalFamily }]);
  }
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      headers: { accept: "image/*", "accept-encoding": "identity" },
      signal,
      lookup: createPublicFeishuImageLookup(lookupFn),
    }, (response) => {
      try {
        resolve(nodeResponseToFetchResponse(response));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end();
  });
}

export function createPublicFeishuImageLookup(
  lookupFn: FeishuImageDnsLookup = dnsLookup,
): LookupFunction {
  return (hostname, _options, callback) => {
    lookupFn(normalizeHostname(hostname), { all: true }, (error, addresses) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      try {
        assertGlobalFeishuImageAddresses(addresses);
        // Bun 1.3 requests `all: true` and requires the array callback form.
        callback(null, addresses);
      } catch (lookupError) {
        callback(lookupError as NodeJS.ErrnoException, "", 0);
      }
    });
  };
}

function nodeResponseToFetchResponse(response: IncomingMessage): Response {
  const status = response.statusCode ?? 500;
  const init = {
    status,
    statusText: response.statusMessage,
    headers: fetchHeaders(response.headers),
  };
  if (status === 204 || status === 205 || status === 304) {
    response.resume();
    return new Response(null, init);
  }
  return new Response(incomingMessageBody(response), init);
}

function fetchHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function incomingMessageBody(message: IncomingMessage): ReadableStream<Uint8Array> {
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        controller.error(error);
      };
      message.on("data", (chunk: Buffer) => {
        if (!finished) controller.enqueue(chunk);
      });
      message.once("end", () => {
        if (finished) return;
        finished = true;
        controller.close();
      });
      message.once("aborted", () => fail(new Error("image response aborted")));
      message.once("error", fail);
    },
    cancel() {
      finished = true;
      message.destroy();
    },
  });
}

function assertGlobalFeishuImageAddresses(addresses: LookupAddress[]): void {
  if (
    addresses.length === 0
    || addresses.some(({ address, family }) => isIP(normalizeHostname(address)) !== family)
    || addresses.some(({ address }) => isNonGlobalFeishuImageIp(address))
  ) {
    throw new Error("image host resolves to a non-global address");
  }
}

function redirectLocation(response: Response): string | null {
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.get("location")?.trim();
  if (!location) throw new Error("image redirect is missing a location");
  return location;
}

export function isNonGlobalFeishuImageIp(value: string): boolean {
  const address = normalizeHostname(value).toLowerCase();
  const family = isIP(address);
  if (family === 4) return isNonGlobalIpv4(parseIpv4(address)!);
  if (family !== 6) return true;
  const bytes = parseIpv6(address);
  if (!bytes) return true;
  if (isIpv4Mapped(bytes)) return isNonGlobalIpv4(bytes.slice(12));

  // Current globally allocated unicast space is 2000::/3. Special-purpose
  // ranges inside it are rejected below, with IANA's globally reachable
  // protocol assignments carved back in.
  if (!matchesPrefix(bytes, parseIpv6("2000::")!, 3)) return true;
  if (matchesPrefix(bytes, parseIpv6("2001::")!, 23)) {
    const globallyReachable = [
      ["2001:1::1", 128],
      ["2001:1::2", 128],
      ["2001:1::3", 128],
      ["2001:3::", 32],
      ["2001:4:112::", 48],
      ["2001:20::", 28],
      ["2001:30::", 28],
    ] as const;
    return !globallyReachable.some(([network, prefix]) => (
      matchesPrefix(bytes, parseIpv6(network)!, prefix)
    ));
  }
  return matchesPrefix(bytes, parseIpv6("2001:db8::")!, 32)
    || matchesPrefix(bytes, parseIpv6("2002::")!, 16)
    || matchesPrefix(bytes, parseIpv6("3fff::")!, 20);
}

function isNonGlobalIpv4(bytes: number[]): boolean {
  const [first, second, third, fourth] = bytes;
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second! >= 64 && second! <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 0 && third === 0 && fourth !== 9 && fourth !== 10)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 88 && third === 99)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113);
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : null;
}

function parseIpv6(value: string): number[] | null {
  let address = value;
  if (address.includes("%")) return null;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = parseIpv4(address.slice(lastColon + 1));
    if (lastColon < 0 || !ipv4) return null;
    address = `${address.slice(0, lastColon)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}`
      + `:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = parseIpv6Hextets(halves[0]!);
  const right = halves.length === 2 ? parseIpv6Hextets(halves[1]!) : [];
  if (!left || !right) return null;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  const hextets = [...left, ...Array<number>(omitted).fill(0), ...right];
  return hextets.flatMap((part) => [part >> 8, part & 0xff]);
}

function parseIpv6Hextets(value: string): number[] | null {
  if (!value) return [];
  const parts = value.split(":");
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function isIpv4Mapped(bytes: number[]): boolean {
  return bytes.length === 16
    && bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
}

function matchesPrefix(address: number[], network: number[], prefixLength: number): boolean {
  const fullBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== network[index]) return false;
  }
  const remainingBits = prefixLength % 8;
  if (!remainingBits) return true;
  const mask = 0xff << (8 - remainingBits);
  return (address[fullBytes]! & mask) === (network[fullBytes]! & mask);
}

function normalizeHostname(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

async function readResponseWithinLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error("image exceeds the Feishu 10MB limit");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("image exceeds the Feishu 10MB limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

function imageContentTypeFromFilename(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function normalizeContentType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
