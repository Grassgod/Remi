import { defineConfig } from "vitest/config";

// Markdown tests render with react-dom/server; files that need a DOM opt in
// with a `@vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
  },
});
