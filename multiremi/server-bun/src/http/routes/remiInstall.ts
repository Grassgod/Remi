import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";

const REPO_ROOT = resolve(import.meta.dir, "../../../../../");
const DIST_DIR = process.env.REMI_CLI_DIST_DIR || join(REPO_ROOT, "dist");
const INSTALL_SCRIPT = process.env.REMI_INSTALL_SCRIPT || join(REPO_ROOT, "scripts", "install-remi.sh");
const ASSET_RE = /^remi-cli-\d+\.\d+\.\d+-(?:linux|darwin)-(?:x64|arm64)\.tar\.gz$/;

function latestVersion(): string {
  const envVersion = process.env.REMI_VERSION?.trim();
  if (envVersion) return envVersion.replace(/^v/, "");
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
    return (pkg.version || "0.0.0").replace(/^v/, "");
  } catch {
    return "0.0.0";
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function publicBaseUrl(c: { req: { query: (name: string) => string | undefined; header: (name: string) => string | undefined } }): string {
  const explicit = c.req.query("base")?.trim();
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit.replace(/\/+$/, "");

  const forwardedHost = c.req.header("X-Forwarded-Host");
  const host = forwardedHost || c.req.header("Host") || "localhost:8080";
  const proto = c.req.header("X-Forwarded-Proto") || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function serveAsset(asset: string): Response {
  if (!ASSET_RE.test(asset)) {
    return new Response("not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const path = join(DIST_DIR, asset);
  if (!existsSync(path)) {
    return new Response("not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${asset}"`,
      "Cache-Control": "public, max-age=300",
    },
  });
}

export function remiInstallRoutes(): Hono {
  const r = new Hono();

  r.get("/api/remi/releases/latest/version", (c) => c.text(latestVersion()));

  r.get("/api/remi/install.sh", (c) => {
    if (!existsSync(INSTALL_SCRIPT)) return c.text("install script not found\n", 404);
    const base = publicBaseUrl(c);
    const version = latestVersion();
    const script = readFileSync(INSTALL_SCRIPT, "utf8");
    const injected = [
      `export REMI_BASE_URL=${shellQuote(base)}`,
      `export REMI_VERSION=${shellQuote(`v${version}`)}`,
      "",
      script,
    ].join("\n");
    return new Response(injected, {
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  });

  r.get("/api/remi/releases/latest/download/:asset", (c) => serveAsset(c.req.param("asset")));
  r.get("/api/remi/releases/download/:tag/:asset", (c) => serveAsset(c.req.param("asset")));

  return r;
}
