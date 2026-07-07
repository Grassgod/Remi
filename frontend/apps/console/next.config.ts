import type { NextConfig } from "next";
import { config } from "dotenv";
import { resolve } from "path";
import { resolveRemoteApiUrl } from "./config/runtime-urls";

// Load root .env so REMOTE_API_URL is available to next.config.ts.
config({ path: resolve(__dirname, "../../.env") });

const remoteApiUrl = resolveRemoteApiUrl(process.env);

const allowedDevOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",")
      .map((origin) => {
        try {
          return new URL(origin.trim()).host;
        } catch {
          return origin.trim();
        }
      })
      .filter(Boolean)
  : undefined;

const nextConfig: NextConfig = {
  // Scope file-tracing to the frontend workspace so Next doesn't infer a wrong
  // root from sibling lockfiles outside frontend/.
  outputFileTracingRoot: resolve(__dirname, "../.."),
  ...(process.env.STANDALONE === "true" ? { output: "standalone" as const } : {}),
  // Shared internal packages export raw .ts/.tsx — Next must transpile them.
  transpilePackages: ["@multiremi/core", "@multiremi/ui", "@multiremi/views", "@multiremi/contracts"],
  ...(allowedDevOrigins && allowedDevOrigins.length > 0
    ? { allowedDevOrigins }
    : {}),
  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [75, 80, 85],
  },
  async rewrites() {
    // Proxy backend traffic to the Multiremi server (board) and Remi admin API.
    return {
      beforeFiles: [],
      afterFiles: [
        {
          source: "/api/:path*",
          destination: `${remoteApiUrl}/api/:path*`,
        },
        {
          source: "/ws",
          destination: `${remoteApiUrl}/ws`,
        },
        {
          source: "/auth/:path*",
          destination: `${remoteApiUrl}/auth/:path*`,
        },
        {
          source: "/uploads/:path*",
          destination: `${remoteApiUrl}/uploads/:path*`,
        },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
