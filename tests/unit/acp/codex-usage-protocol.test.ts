import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCodexRequestUsageProtocol } from "@acp/runtime-verify.js";

// A bundle whose @openai/codex writes the app-server schema the way codex
// 0.162.1 `app-server generate-json-schema --experimental --out` does.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function bundle(schema: { rawEvents?: boolean; optOut?: boolean; responseId?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "remi-codex-protocol-test-"));
  dirs.push(root);
  const bridge = join(root, "node_modules", "@agentclientprotocol", "codex-acp");
  mkdirSync(join(bridge, "dist"), { recursive: true });
  writeFileSync(join(bridge, "dist", "index.js"), "");
  const codex = join(root, "node_modules", "@openai", "codex");
  mkdirSync(join(codex, "bin"), { recursive: true });
  writeFileSync(join(codex, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.162.1" }));
  const files = {
    "v2/ThreadStartParams.json": { properties: { cwd: { type: ["string", "null"] },
      ...(schema.rawEvents === false ? {} : { experimentalRawEvents: { type: "boolean" } }) } },
    "v2/RawResponseCompletedNotification.json": { required: ["threadId", "turnId", ...(schema.responseId === false ? [] : ["responseId"])],
      properties: { usage: { anyOf: [{ $ref: "#/definitions/TokenUsageBreakdown" }, { type: "null" }] } } },
    "v1/InitializeParams.json": { definitions: { InitializeCapabilities: { properties: { experimentalApi: { type: "boolean" },
      ...(schema.optOut === false ? {} : { optOutNotificationMethods: { type: ["array", "null"] } }) } } } },
  };
  writeFileSync(join(codex, "bin", "codex.js"), `const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const args = process.argv.slice(2);
if (args.join(" ") !== "app-server generate-json-schema --experimental --out " + args[4]) process.exit(2);
for (const [file, body] of Object.entries(${JSON.stringify(files)})) {
  mkdirSync(dirname(join(args[4], file)), { recursive: true });
  writeFileSync(join(args[4], file), JSON.stringify(body));
}
`);
  return bridge;
}

it("accepts the app-server protocol the usage patch and rollout reader rely on", () => {
  expect(() => verifyCodexRequestUsageProtocol(bundle())).not.toThrow();
});

it("fails runtime preparation when request usage would silently stop", () => {
  expect(() => verifyCodexRequestUsageProtocol(bundle({ rawEvents: false }))).toThrow("thread/start experimentalRawEvents");
  expect(() => verifyCodexRequestUsageProtocol(bundle({ optOut: false }))).toThrow("initialize optOutNotificationMethods");
  expect(() => verifyCodexRequestUsageProtocol(bundle({ responseId: false }))).toThrow("rawResponse/completed");
});
