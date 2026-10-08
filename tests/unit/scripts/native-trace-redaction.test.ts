import { expect, test } from "bun:test";
import { redactNativeTrace } from "../../../scripts/lib/native-trace-redaction.js";
test("recovery redacts credential values while preserving task identity, commands and hashes", () => {
  const token = "mat_" + "a".repeat(40);
  const input = [{ seq: 1, ts: "2026-10-04T00:00:00Z", type: "tool_result", tool_call_id: "call_1", output: `Authorization: Bearer ${token}\ncommit=${"b".repeat(40)}\nAPI_KEY=1234567890abcdefghijkl`, input: { command: "echo $MULTIREMI_TOKEN", headers: { Authorization: "Bearer " + "s".repeat(30) } } }];
  const result = redactNativeTrace(input);
  expect(JSON.stringify(result.events)).not.toContain(token);
  expect(JSON.stringify(result.events)).not.toContain("1234567890abcdefghijkl");
  expect(JSON.stringify(result.events)).not.toContain("s".repeat(30));
  expect(result.events[0]!.tool_call_id).toBe("call_1");
  expect(result.events[0]!.output).toContain("b".repeat(40));
  expect(result.events[0]!.input?.command).toBe("echo $MULTIREMI_TOKEN");
  expect(input[0]!.output).toContain(token);
  expect(redactNativeTrace(result.events).redactions).toBe(0);
});
