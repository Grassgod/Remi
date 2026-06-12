/**
 * Agent template catalog: list returns picker summaries (no instructions body),
 * detail returns the full template, unknown slug → 404. Pure static data, no DB.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import { agentTemplateRoutes } from "../src/http/routes/agentTemplates.js";
import { loadAgentTemplates } from "../src/agent/templates.js";
import type { AppEnv } from "../src/http/types.js";

const app = new Hono<AppEnv>();
app.route("/api/agent-templates", agentTemplateRoutes());

test("loadAgentTemplates parses the full catalog (slug == filename)", () => {
  const all = loadAgentTemplates();
  expect(all.length).toBeGreaterThanOrEqual(20);
  for (const t of all) {
    expect(typeof t.slug).toBe("string");
    expect(t.instructions.length).toBeGreaterThan(0);
    expect(Array.isArray(t.skills)).toBe(true);
  }
});

test("list returns summaries WITHOUT the instructions body", async () => {
  const res = await app.request("/api/agent-templates");
  expect(res.status).toBe(200);
  const list = (await res.json()) as Array<Record<string, unknown>>;
  expect(list.length).toBeGreaterThanOrEqual(20);
  expect(list[0]).toHaveProperty("slug");
  expect(list[0]).toHaveProperty("name");
  expect(list[0]).not.toHaveProperty("instructions");
});

test("detail returns the full template including instructions", async () => {
  const res = await app.request("/api/agent-templates/summarizer");
  expect(res.status).toBe(200);
  const t = (await res.json()) as { slug: string; instructions: string };
  expect(t.slug).toBe("summarizer");
  expect(t.instructions.length).toBeGreaterThan(0);
});

test("unknown slug → 404", async () => {
  const res = await app.request("/api/agent-templates/does-not-exist");
  expect(res.status).toBe(404);
});
