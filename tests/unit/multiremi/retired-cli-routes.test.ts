import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { RETIRED_CLI_ROUTES, registerRetiredCliRoutes } from "@multiremi/api/retired-cli-routes.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";

describe("retired HTTP routes", () => {
  for (const [route, replacement] of Object.entries(RETIRED_CLI_ROUTES)) it(route, async () => {
    const app = new Hono();
    registerRetiredCliRoutes(app);
    let businessCalls = 0;
    const separator = route.indexOf(" "), method = route.slice(0, separator), template = route.slice(separator + 1);
    app.on(method, template, (c) => { businessCalls++; return c.json({ unexpected: true }); });
    const path = template.replace(/:[^/]+/g, "missing");
    const response = await app.request(path, { method, ...(method === "GET" ? {} : { body: "{not-json" }) });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ code: "route_retired", replacement });
    expect(businessCalls).toBe(0);
  });
  it("installs every stub in the real app before resource lookup or legacy writes", async () => {
    const db = openSqliteDatabase(":memory:");
    const store = new MultiremiStore(db);
    try {
      store.ensureLocalWorkspace();
      const app = createMultiremiApp({ store });
      for (const [route, replacement] of Object.entries(RETIRED_CLI_ROUTES)) {
        const separator = route.indexOf(" "), method = route.slice(0, separator);
        const path = route.slice(separator + 1).replace(/:[^/]+/g, "missing");
        const response = await app.request(path, { method, ...(method === "GET" ? {} : { body: "{not-json" }) });
        expect(response.status, route).toBe(410);
        expect(await response.json(), route).toEqual({ code: "route_retired", replacement });
      }
    } finally { store.stopNotificationDeliverySweeper(); db.close(); }
  });
  it("excludes paths reused by the new message and cursor contracts", () => {
    expect(RETIRED_CLI_ROUTES["GET /api/inbox"]).toBeUndefined();
    expect(RETIRED_CLI_ROUTES["POST /api/inbox/read"]).toBeUndefined();
    expect(RETIRED_CLI_ROUTES["GET /api/sessions/:id/messages"]).toBeUndefined();
    expect(RETIRED_CLI_ROUTES["POST /api/sessions/:id/messages"]).toBeUndefined();
  });
});
