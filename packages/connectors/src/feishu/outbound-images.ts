import { readFile, stat } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
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

export interface FeishuImageResolverOptions {
  uploadImage: (image: LoadedFeishuImage) => Promise<string | null | undefined>;
  loadAttachment?: FeishuAttachmentImageLoader;
  fetchFn?: FeishuImageFetch;
  maxBytes?: number;
  timeoutMs?: number;
  assertRemoteHost?: FeishuImageHostGuard;
  cache?: Map<string, Promise<string | null>>;
}

export function createFeishuImageResolver(options: FeishuImageResolverOptions): MarkdownImageResolver {
  const cache = options.cache ?? new Map<string, Promise<string | null>>();
  return async (source) => {
    if (source.kind === "feishu") return source.imageKey;
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
    "loadAttachment" | "fetchFn" | "maxBytes" | "timeoutMs" | "assertRemoteHost"
  > = {},
): Promise<LoadedFeishuImage | null> {
  const maxBytes = positiveLimit(options.maxBytes, FEISHU_IMAGE_MAX_BYTES);
  if (source.kind === "feishu" || source.kind === "unsupported") return null;
  if (source.kind === "attachment") {
    if (!options.loadAttachment) return null;
    const loaded = await options.loadAttachment(source);
    return loaded ? validateFeishuImage(loaded, maxBytes) : null;
  }
  if (source.kind === "local") {
    const info = await stat(source.filePath);
    if (!info.isFile()) throw new Error("image source is not a file");
    if (info.size > maxBytes) throw new Error("image exceeds the Feishu 10MB limit");
    return validateFeishuImage({
      buffer: await readFile(source.filePath),
      contentType: imageContentTypeFromFilename(source.filePath),
      fileName: source.name,
    }, maxBytes);
  }
  return fetchImageWithTimeout(
    source.url,
    options.fetchFn ?? fetch,
    positiveLimit(options.timeoutMs, FEISHU_IMAGE_DOWNLOAD_TIMEOUT_MS),
    source.name,
    maxBytes,
    options.assertRemoteHost ?? assertPublicFeishuImageHost,
  );
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
  fetchFn: FeishuImageFetch,
  timeoutMs: number,
  fileName: string,
  maxBytes: number,
  assertRemoteHost: FeishuImageHostGuard,
): Promise<LoadedFeishuImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = new URL(url);
    for (let redirects = 0; redirects <= FEISHU_IMAGE_MAX_REDIRECTS; redirects += 1) {
      if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
        throw new Error("image redirect used an unsupported protocol");
      }
      await assertRemoteHost(currentUrl.hostname);
      const response = await fetchFn(currentUrl, { signal: controller.signal, redirect: "manual" });
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
  const addresses = await dnsLookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("image host resolves to a private address");
  }
}

function redirectLocation(response: Response): string | null {
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.get("location")?.trim();
  if (!location) throw new Error("image redirect is missing a location");
  return location;
}

function isPrivateIp(value: string): boolean {
  let address = value.toLowerCase();
  const mapped = address.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u);
  if (mapped) address = mapped[1]!;
  const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19));
  }
  return address === "::" || address === "::1"
    || /^fe[89ab]/u.test(address)
    || address.startsWith("fc")
    || address.startsWith("fd");
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
