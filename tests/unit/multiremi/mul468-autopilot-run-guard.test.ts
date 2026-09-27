/**
 * MUL-468: `remi autopilot run <autopilot>` looked like the read-only
 * `run list` / `run get` queries — the parent help even printed the run-list
 * description on that line — but it POSTed the trigger endpoint and started a
 * run. Two people read it as a query on 2026-09-27 and launched runs they did
 * not ask for.
 *
 * These tests drive the real dispatcher against a local HTTP fixture and pin:
 * the guard sends nothing at all, the renamed `run-now` is the only write path,
 * `task steer` fails locally instead of POSTing an empty directive, and the
 * Registry invariant that keeps every command with subcommands read-only.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cliCommandHelp, cliCommandInventory, dispatch } from "../../../apps/remi/cli/index.js";
import { CommandRegistry, type CommandSpec } from "../../../apps/remi/cli/core/index.js";

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface DispatchResult {
  error: unknown;
  exitCode: number | null;
  stderr: string[];
  stdout: string[];
}

const realExit = process.exit;
const realConsoleError = console.error;
const realConsoleLog = console.log;

let server: ReturnType<typeof Bun.serve> | null = null;
let requests: RecordedRequest[] = [];

const CLI_CAPABILITIES = [
  "autopilot.run.list",
  "autopilot.run.get",
  "autopilot.run-now",
  "task.steer",
  "task.steer.list",
];

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  process.exit = realExit;
  console.error = realConsoleError;
  console.log = realConsoleLog;
  if (server) server.stop(true);
  server = null;
});

class ProcessExitError extends Error {
  constructor(readonly code: number | null) {
    super(`process.exit(${code})`);
  }
}

/** Serve the routes the CLI touches, record every hit, and return the base URL. */
function startFixture(): string {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" || request.method === "DELETE"
        ? null
        : await request.text();
      requests.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: body ? JSON.parse(body) : null,
      });
      if (url.pathname === "/api/cli/capabilities") {
        return Response.json({ commands: CLI_CAPABILITIES.map((id) => ({ id, allowed: true })) });
      }
      if (url.pathname === "/api/autopilots") {
        return Response.json({ autopilots: [{ id: "aut_x", name: "Nightly audit" }] });
      }
      if (url.pathname.endsWith("/trigger")) {
        return Response.json({ run: { id: "run_1", status: "queued" } }, { status: 201 });
      }
      if (url.pathname.endsWith("/runs")) {
        return Response.json({ runs: [{ id: "run_1", status: "completed" }] });
      }
      if (url.pathname.endsWith("/steer")) {
        return Response.json({ message: { id: "stm_1" } }, { status: 201 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function connectionOptions(baseUrl: string): string[] {
  return ["--server", baseUrl, "--token", "tok_mul468", "--workspace", "local", "--output", "json"];
}

async function runDispatch(args: string[]): Promise<DispatchResult> {
  const stderr: string[] = [];
  const stdout: string[] = [];
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  console.log = (...parts: unknown[]) => { stdout.push(parts.map(String).join(" ")); };
  process.exit = ((code?: number) => { throw new ProcessExitError(code ?? 0); }) as typeof process.exit;
  try {
    await dispatch(args);
    return { error: null, exitCode: null, stderr, stdout };
  } catch (err) {
    if (err instanceof ProcessExitError) return { error: null, exitCode: err.code, stderr, stdout };
    return { error: err, exitCode: null, stderr, stdout };
  }
}

function posts(): RecordedRequest[] {
  return requests.filter((entry) => entry.method === "POST");
}

describe("MUL-468 autopilot run guard", () => {
  it("refuses `autopilot run <autopilot>` without sending any HTTP request", async () => {
    const baseUrl = startFixture();
    const result = await runDispatch(["autopilot", "run", "aut_x", ...connectionOptions(baseUrl)]);

    const message = String((result.error as Error | null)?.message ?? "");
    expect(message).toContain("no longer starts a run");
    expect(message).toContain("remi autopilot run list <autopilot>");
    expect(message).toContain("remi autopilot run get <autopilot> <run>");
    expect(message).toContain("remi autopilot run-now <autopilot>");
    expect((result.error as { code?: string } | null)?.code).toBe("usage");
    // The guard must not even resolve the autopilot name: zero hits, GET or POST.
    expect(requests).toEqual([]);
  });

  it("starts exactly one run through `autopilot run-now`", async () => {
    const baseUrl = startFixture();
    const result = await runDispatch(["autopilot", "run-now", "aut_x", ...connectionOptions(baseUrl)]);

    expect(result.error).toBeNull();
    // run-now keeps the shared autopilot name resolution every other autopilot
    // command uses, so after capability negotiation the only request is the
    // trigger that starts the run.
    expect(requests.filter((entry) => entry.path !== "/api/cli/capabilities")
      .map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /api/autopilots?workspace_id=local",
      "POST /api/autopilots/aut_x/trigger",
    ]);
    expect(posts()).toHaveLength(1);
    expect(requests.some((entry) => entry.path.includes("/run"))).toBe(false);
  });

  it("keeps `autopilot run list` read-only", async () => {
    const baseUrl = startFixture();
    const result = await runDispatch(["autopilot", "run", "list", "aut_x", ...connectionOptions(baseUrl)]);

    expect(result.error).toBeNull();
    expect(posts()).toEqual([]);
    expect(requests.filter((entry) => entry.method === "GET" && entry.path.startsWith("/api/autopilots/aut_x/runs")))
      .toHaveLength(1);
  });

  it("fails `task steer` locally when no directive input is supplied", async () => {
    const baseUrl = startFixture();
    const result = await runDispatch(["task", "steer", "tsk_mul468", ...connectionOptions(baseUrl)]);

    const message = String((result.error as Error | null)?.message ?? "");
    expect(message).toContain("remi task steer requires");
    expect(message).toContain("remi task steer list <task>");
    expect(requests).toEqual([]);
  });

  it("still posts `task steer` when a directive is supplied", async () => {
    const baseUrl = startFixture();
    const result = await runDispatch([
      "task", "steer", "tsk_mul468", "--content", "wrap up the review", ...connectionOptions(baseUrl),
    ]);

    expect(result.error).toBeNull();
    const writes = posts();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: "/api/tasks/tsk_mul468/steer" });
    expect((writes[0]!.body as { content?: string }).content).toBe("wrap up the review");
  });

  it("renders `autopilot run` as a group and names run-now in the parent help", async () => {
    const help = await runDispatch(["autopilot", "--help"]);
    const text = help.stdout.join("\n");
    const runLine = text.split("\n").find((line) => /^\s+autopilot run\s/.test(line)) ?? "";

    expect(runLine).not.toContain("List autopilot runs including queued schedule targets");
    expect(runLine).toContain("start one with autopilot run-now");
    expect(text).toContain("autopilot run-now");

    // The exact regression from the incident: no command that mutates state may
    // be labelled with the run-list description in any group listing.
    const runListDescription = "List autopilot runs including queued schedule targets";
    const inventory = cliCommandInventory();
    const nonRead = inventory.filter((candidate) => candidate.mutation !== "read");
    expect(nonRead.length).toBeGreaterThan(0);
    for (const entry of nonRead) {
      expect(cliCommandHelp(entry.path), entry.id).not.toContain(runListDescription);
    }

    // Generic invariant behind the bug: `uniqueDirectChildren` must render a
    // path that is itself a command with that command's own description, never
    // with the description of its first child. A write command borrowing a
    // read command's line is how `autopilot run` came to look like a query.
    const parentsChecked = new Set<string>();
    for (const entry of inventory.filter((candidate) => !candidate.hidden && candidate.path.length > 1)) {
      const parentPath = entry.path.slice(0, -1);
      const hasChild = inventory.some((other) =>
        other.path.length > entry.path.length
        && entry.path.every((segment, index) => other.path[index] === segment));
      if (!hasChild) continue;
      const parentKey = parentPath.join(" ");
      if (parentsChecked.has(parentKey)) continue;
      parentsChecked.add(parentKey);
      const parentHelp = cliCommandHelp(parentPath);
      const line = parentHelp.split("\n")
        .find((candidate) => candidate.trim().split(/\s{2,}/)[0] === entry.path.join(" "));
      expect(line, `${entry.id} missing from help of ${parentKey}`).toBeDefined();
      expect(line, entry.id).toContain(entry.description);
    }
    expect(parentsChecked.size).toBeGreaterThan(0);
  });

  it("renders a command's own description on a path that also has subcommands", () => {
    // Independent of registration order: whichever entry lands first, the line
    // for an existing path must describe that path, not its child.
    const specs: CommandSpec[] = [
      {
        id: "fixture.parent.child",
        path: ["fixture", "parent", "child"],
        description: "List fixture children",
        run: async () => {},
      },
      {
        id: "fixture.parent",
        path: ["fixture", "parent"],
        description: "Write the fixture parent",
        mutation: "write",
        run: async () => {},
      },
    ];
    for (const ordered of [specs, [...specs].reverse()]) {
      const registry = new CommandRegistry();
      for (const spec of ordered) registry.register(spec);
      const lines = registry.renderHelp(["fixture"]).split("\n");
      const parentLine = lines.find((line) => line.trim().split(/\s{2,}/)[0] === "fixture parent");
      expect(parentLine, ordered.map((spec) => spec.id).join(",")).toContain("Write the fixture parent");
      expect(parentLine).not.toContain("List fixture children");
    }
  });

  it("registers no writable command at a path that also has subcommands", () => {
    const inventory = cliCommandInventory();
    const nestedWritesWithReason: Record<string, string> = {
      // `task steer <task>` writes a directive while `task steer list <task>`
      // reads the ones already sent. A bare steer now fails before the request,
      // so the prefix can no longer post anything by accident (see above).
      "task.steer": "Writes a steer directive; the bare form is guarded locally",
    };
    const violations: string[] = [];
    for (const entry of inventory) {
      const hasChild = inventory.some((other) =>
        other.path.length > entry.path.length
        && entry.path.every((segment, index) => other.path[index] === segment));
      if (!hasChild) continue;
      if (entry.mutation === "read") continue;
      if (nestedWritesWithReason[entry.id]) continue;
      violations.push(`${entry.id} (${entry.path.join(" ")}) is ${entry.mutation} and has subcommands`);
    }
    expect(violations).toEqual([]);
    expect(inventory.some((entry) => entry.id === "autopilot.run")).toBe(false);
    expect(inventory.find((entry) => entry.id === "autopilot.run.group")).toMatchObject({
      path: ["autopilot", "run"],
      mutation: "read",
    });
    // The allowlist above must not outlive the exception it documents.
    for (const id of Object.keys(nestedWritesWithReason)) {
      expect(inventory.some((entry) => entry.id === id), id).toBe(true);
    }
  });
});
