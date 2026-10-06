import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IssueDetailSchema } from "@multiremi/core/api/schemas/issues";
import { IssueSessionSchema } from "@multiremi/core/api/schemas/comments";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined, navigation: "document" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => cookie.value ? { value: cookie.value } : undefined }),
  headers: async () => new Headers({ accept: cookie.navigation === "soft-nav" ? "*/*" : "text/html" }) }));
import { readIssueLogBootstrap, readIssueLogBootstrapResult, readIssuePageBootstrap, readSSRWorkspace, readWithSessionCookie, SSR_LOG_TIMEOUT_MS } from "./server-log";

afterEach(() => { cookie.value = undefined; cookie.navigation = "document"; vi.unstubAllGlobals(); });

describe("Issue SSR cookie reader", () => {
  it("skips all page and workspace reads on soft navigation before consulting cookies", async () => {
    cookie.value = "synthetic";
    cookie.navigation = "soft-nav";
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await readIssuePageBootstrap("test", "issue")).toEqual({ status: "soft-nav", initial: null });
    expect(await readSSRWorkspace("test")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports the absence of a cookie without making requests", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await readIssuePageBootstrap("test", "issue")).toEqual({ status: "no-cookie", initial: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [404, "not-found"], [401, "upstream-error"], [503, "upstream-error"],
    [200, "invalid"],
  ])("reports only the enum for HTTP %s", async (status, expected) => {
    cookie.value = "synthetic";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private malformed body", { status })));
    expect(await readIssueLogBootstrapResult("test", "issue")).toEqual({ status: expected, initial: null });
  });
  it("reports a shared Issue deadline as timeout without retaining partial data", async () => {
    cookie.value = "synthetic";
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private upstream")), { once: true });
    })));
    expect(await readIssueLogBootstrapResult("test", "issue")).toEqual({ status: "timeout", initial: null });
  });
  it("does not request without a cookie", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await readWithSessionCookie({ cookie: undefined, slug: "test", path: "/api/sessions/s/log", schema: z.array(z.string()), fetcher })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 503])("returns only the shell seed for HTTP %s", async status => {
    expect(await readWithSessionCookie({ cookie: "synthetic", slug: "test", path: "/log", schema: z.array(z.string()),
      fetcher: vi.fn(async () => new Response("upstream private error", { status })) as unknown as typeof fetch })).toBeNull();
  });
  it("uses the 800ms deadline and suppresses sensitive upstream errors", async () => {
    const errorLog = vi.spyOn(console, "error");
    const warnLog = vi.spyOn(console, "warn");
    const started = performance.now();
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("synthetic cookie must stay private")), { once: true });
    })) as unknown as typeof fetch;
    expect(await readWithSessionCookie({ cookie: "synthetic", slug: "test", path: "/log", schema: z.array(z.string()), fetcher })).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(SSR_LOG_TIMEOUT_MS - 20);
    expect(performance.now() - started).toBeLessThan(1_200);
    expect(errorLog).not.toHaveBeenCalled(); expect(warnLog).not.toHaveBeenCalled();
    errorLog.mockRestore(); warnLog.mockRestore();
  });
  it("forwards only the httpOnly cookie and workspace; invalid data cannot become a seed", async () => {
    const seen: RequestInit[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => { seen.push(init!); return Response.json({ unexpected: true }); }) as unknown as typeof fetch;
    expect(await readWithSessionCookie({ cookie: "synthetic", slug: "test", path: "/log", schema: z.array(z.string()), fetcher })).toBeNull();
    const headers = new Headers(seen[0]?.headers);
    expect(headers.has("cookie")).toBe(true); expect(headers.has("authorization")).toBe(false);
    expect(headers.get("x-workspace-slug")).toBe("test");
    expect(seen[0]?.cache).toBe("no-store"); expect(seen[0]?.redirect).toBe("error");
  });
});

describe("Issue SSR missing-comment fallback", () => {
  const issue = IssueDetailSchema.parse({ id: "issue", workspace_id: "w", number: 1, identifier: "MUL-1",
    title: "Synthetic issue", description: "", status: "todo", priority: "medium", assignee_type: null, assignee_id: null,
    creator_type: "member", creator_id: "u", parent_issue_id: null, project_id: null, position: 0,
    start_date: null, due_date: null, created_at: "", updated_at: "", pending_decision_count: 0, parent_done_grant: null });
  const sessions = ["side", "main"].map(id => IssueSessionSchema.parse({ id, issue_id: "issue", workspace_id: "w",
    title: id, status: "active", is_default: id === "main", created_at: "", updated_at: "" }));
  const row = (id: string, seq: number) => SessionLogEntrySchema.parse({ id, seq, session_id: "main", revision: 1,
    kind: seq === 0 ? "head" : "message", body_md: id, body_html: null, render_version: null });
  const window = (entries = [row("retained", 1)]) => ({ entries, head_seq: 1, log_version: 1, has_more_before: false, has_more_after: false });
  function mockReads(locate: (session: string) => Response | Promise<Response>) {
    cookie.value = "synthetic";
    const fetcher = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path.endsWith("/log/locate")) return locate(path.split("/")[3]!);
      if (path.endsWith("/log")) return Response.json(window(url.searchParams.get("anchor") === "0" ? [row("head", 0)] : undefined));
      if (path.endsWith("/sessions")) return Response.json(sessions);
      if (path.endsWith("/members") || path.endsWith("/task-runs")) return Response.json([]);
      if (path.endsWith("/children")) return Response.json({ issues: [] });
      return Response.json(issue);
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  it.each([
    ["deleted-comment", "side"], ["missing-comment", "side"],
    ["deleted-comment", undefined], ["missing-comment", undefined],
  ])("seeds a normal tail for %s (selected session: %s)", async (target, selected) => {
    const fetcher = mockReads(() => new Response("entry not found", { status: 404 }));
    const bootstrap = await readIssueLogBootstrap("test", "issue", selected, target);
    expect(bootstrap?.log).toMatchObject({ sessionId: selected ?? "main", missingCommentId: target });
    expect(bootstrap?.log.targetCommentId).toBeUndefined();
    expect(bootstrap?.log.window.entries[0]?.id).toBe("retained");
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith(`/sessions/${selected ?? "main"}/log?before=30${selected ? "" : "&with_activity=1"}`))).toBe(true);
  });

  it.each([503, "network"])("does not treat %s as a missing comment", async failure => {
    const fetcher = mockReads(() => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      return new Response("unavailable", { status: failure as number });
    });
    expect(await readIssueLogBootstrap("test", "issue", undefined, "target")).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/log?"))).toBe(false);
  });

  it("keeps a valid target's session and anchor window", async () => {
    const fetcher = mockReads(session => session === "side"
      ? Response.json({ id: "retained", seq: 1, head_seq: 1 }) : new Response("entry not found", { status: 404 }));
    const bootstrap = await readIssueLogBootstrap("test", "issue", undefined, "retained");
    expect(bootstrap?.log).toMatchObject({ sessionId: "side", targetCommentId: "retained" });
    expect(bootstrap?.log.missingCommentId).toBeUndefined();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/sessions/side/log?anchor=1&before=15&after=15"))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).searchParams.has("with_activity"))).toBe(false);
  });

  it("requests default-session activities in the SSR window, without changing the head read", async () => {
    const fetcher = mockReads(() => Response.json({ id: "retained", seq: 1, head_seq: 1 }));
    await readIssueLogBootstrap("test", "issue", "main", "retained");
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/sessions/main/log?anchor=1&before=15&after=15&with_activity=1"))).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).searchParams.get("anchor") === "0")
      .every(([url]) => !new URL(String(url)).searchParams.has("with_activity"))).toBe(true);
  });

  it("only reports ok with a complete bootstrap, including a requested parent", async () => {
    const fetcher = mockReads(() => new Response("missing", { status: 404 }));
    expect(await readIssueLogBootstrapResult("test", "issue")).toMatchObject({ status: "ok", initial: { issue } });
    fetcher.mockImplementation(async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/sessions")) return Response.json(sessions);
      if (path === "/api/issues/issue") return Response.json({ ...issue, parent_issue_id: "parent" });
      if (path === "/api/issues/parent") return new Response("private parent", { status: 503 });
      if (path.endsWith("/log")) return Response.json(window());
      if (path.endsWith("/children")) return Response.json({ issues: [] });
      return Response.json([]);
    });
    expect(await readIssueLogBootstrapResult("test", "issue")).toEqual({ status: "upstream-error", initial: null });
  });

  it("does not seed a fallback when another session could not be checked", async () => {
    mockReads(session => new Response("unavailable", { status: session === "side" ? 503 : 404 }));
    expect(await readIssueLogBootstrap("test", "issue", undefined, "target")).toBeNull();
  });
});
