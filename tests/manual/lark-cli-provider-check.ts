/**
 * Verifies LarkCliMessageProvider against the lark-cli binary actually installed
 * on this host, which the unit suite cannot do: those tests inject a fake runner,
 * so an argv the real CLI rejects still passes there.
 *
 * Requires an authorized lark-cli. Run: bun run tests/manual/lark-cli-provider-check.ts
 */
import { MessageProviderError, type MessageProviderContext } from "@multiremi/contracts/messaging.js";
import { LarkCliMessageProvider } from "@multiremi/messaging/providers/lark-cli/provider.js";
import { BunLarkCliRunner } from "@multiremi/messaging/providers/lark-cli/runner.js";

const context = {
  connection: {
    id: "manual", workspaceId: "local", provider: "lark_cli", channel: "feishu", name: "manual",
    externalAccountId: null, externalAccountName: null, status: "ready", config: {},
    lastCheckedAt: null, lastErrorCode: null, lastErrorAt: null, createdAt: "", updatedAt: "",
  },
} as unknown as MessageProviderContext;

const health = await new LarkCliMessageProvider().checkHealth(context);
console.log("health:", JSON.stringify(health));
if (health.status !== "ready") console.log("  (authorize with `lark-cli auth login` to exercise the rest)");

// Error classification drives the retry policy and the connection status shown
// in the UI, so it is checked against real CLI failures rather than fixtures.
const runner = new BunLarkCliRunner();
const expectations: Array<[string, string[], string]> = [
  ["unknown subcommand", ["im", "+does-not-exist", "--format", "json"], "capability_unsupported"],
  ["un-granted scope", ["im", "+messages-send", "--as", "user", "--chat-id", "oc_x", "--text", "hi", "--dry-run", "--format", "json"], "forbidden"],
];
let failures = 0;
for (const [label, argv, expected] of expectations) {
  const actual = await runner.run(argv).then(() => "ok", (error) => (error as MessageProviderError).code);
  const verdict = actual === expected ? "PASS" : "FAIL";
  if (actual !== expected) failures += 1;
  console.log(`${verdict} ${label}: expected ${expected}, got ${actual}`);
}
process.exit(failures === 0 && health.status === "ready" ? 0 : 1);
