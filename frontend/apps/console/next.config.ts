import type { NextConfig } from "next";
import { resolve } from "path";

const nextConfig: NextConfig = {
  // Scope file-tracing to the frontend workspace so Next doesn't infer a wrong
  // root from sibling lockfiles outside frontend/.
  outputFileTracingRoot: resolve(__dirname, "../.."),
  ...(process.env.STANDALONE === "true" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
