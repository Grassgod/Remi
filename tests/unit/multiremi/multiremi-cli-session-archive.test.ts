import { describe, expect, test } from "bun:test";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";

describe("Multiremi CLI — issue session archives", () => {
  test("status, list, verify, and retry use the issue archive API", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const ready = {
      id: "arc_ready",
      status: "ready",
      sha256: "abc",
      size_bytes: 10,
    };
    const failed = {
      id: "arc_failed",
      status: "failed",
      last_error: "disk full",
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ method: request.method, path: url.pathname });
        if (url.pathname === "/api/issues/MUL-55/session-archives") {
          return Response.json({
            archives: [ready, failed],
            latest: failed,
            latest_ready: ready,
          });
        }
        if (url.pathname === "/api/issues/MUL-55/session-archives/arc_ready/verify") {
          return Response.json({ archive: ready, valid: true });
        }
        if (url.pathname === "/api/issues/MUL-55/session-archives/arc_failed/retry") {
          return Response.json({ archive: { ...failed, status: "pending" } });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { logs.push(String(value)); };
      const connection = [
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--token",
        "tok_cli",
        "--output",
        "json",
      ];

      await runMultiremi(["issue", "archive", "status", "MUL-55", ...connection], { programName: "multiremi" });
      await runMultiremi(["issue", "archive", "list", "MUL-55", ...connection], { programName: "multiremi" });
      await runMultiremi(["issue", "archive", "verify", "MUL-55", ...connection], { programName: "multiremi" });
      await runMultiremi(["issue", "archive", "retry", "MUL-55", ...connection], { programName: "multiremi" });

      expect(JSON.parse(logs[0])).toMatchObject({
        issue_id: "MUL-55",
        total: 2,
        ready: 1,
        failed: 1,
        latest: { id: "arc_failed" },
        latest_ready: { id: "arc_ready" },
      });
      expect(JSON.parse(logs[1]).archives).toHaveLength(2);
      expect(JSON.parse(logs[2])).toMatchObject({ valid: true });
      expect(JSON.parse(logs[3])).toMatchObject({ archive: { status: "pending" } });
      expect(requests).toEqual([
        { method: "GET", path: "/api/issues/MUL-55/session-archives" },
        { method: "GET", path: "/api/issues/MUL-55/session-archives" },
        { method: "GET", path: "/api/issues/MUL-55/session-archives" },
        { method: "POST", path: "/api/issues/MUL-55/session-archives/arc_ready/verify" },
        { method: "GET", path: "/api/issues/MUL-55/session-archives" },
        { method: "POST", path: "/api/issues/MUL-55/session-archives/arc_failed/retry" },
      ]);
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

  test("verify and retry explain when no suitable archive exists", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ archives: [], latest: null, latest_ready: null });
      },
    });
    try {
      const connection = ["--server", `http://127.0.0.1:${server.port}`, "--token", "tok_cli"];
      await expect(
        runMultiremi(["issue", "archive", "verify", "MUL-55", ...connection], { programName: "multiremi" }),
      ).rejects.toThrow("no ready session archive found for MUL-55");
      await expect(
        runMultiremi(["issue", "archive", "retry", "MUL-55", ...connection], { programName: "multiremi" }),
      ).rejects.toThrow("no failed session archive found for MUL-55");
    } finally {
      server.stop(true);
    }
  });
});
