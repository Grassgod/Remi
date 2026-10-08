import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";
import { assertDefaultDetailPage } from "./usage-day-model-cases.js";
afterEach(resetMultiremiTestEnv);

it("validates lazy detail query parameters and rejects scope changes through the actual HTTP router", async () => {
  const store = createLocalStore(); assertDefaultDetailPage(store, "http-joint");
  const app = createMultiremiApp({ store });
  const base = "/api/usage/report?workspace_id=local&days=all&tz=UTC";
  const plain = await app.request(base); expect(plain.status).toBe(200); expect(await plain.json()).not.toHaveProperty("day_model");
  const first = await app.request(`${base}&include=day_model&detail_limit=1`); expect(first.status).toBe(200);
  const body = await first.json(); expect(body.day_model.rows).toHaveLength(1);
  const cursor = encodeURIComponent(body.day_model.next_cursor);
  expect((await app.request(`${base}&include=day_model&detail_limit=1&detail_cursor=${cursor}`)).status).toBe(200);
  for (const suffix of ["&include=wrong", "&include=day_model&detail_limit=501", "&include=day_model&detail_limit=0", "&include=day_model&detail_limit=1.1", "&detail_limit=2", "&include=day_model&detail_cursor=bad",
    `&include=day_model&detail_cursor=${cursor}&since=2026-10-02T00:00:00Z`]) expect((await app.request(`${base}${suffix}`)).status).toBe(400);
  expect((await app.request(`${base}&include=day_model&runtime_id=not-in-workspace`)).status).toBe(404);
});
