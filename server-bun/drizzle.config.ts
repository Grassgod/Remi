import type { Config } from "drizzle-kit";
export default {
  dialect: "postgresql",
  out: "./drizzle-introspect",
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
