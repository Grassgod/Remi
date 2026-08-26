import { describe, expect, it } from "bun:test";
import {
  executeRuntimeCommand,
  redactRuntimeCommandArgs,
  redactRuntimeCommandText,
  truncateRuntimeCommandOutput,
} from "@multiremi/worker/runtime-command.js";

describe("runtime command execution", () => {
  it("classifies a non-zero exit as completed and preserves both output streams", async () => {
    const result = await executeRuntimeCommand({
      command: "printf stdout-value; printf stderr-value >&2; exit 7",
      timeoutMs: 2_000,
    });

    expect(result).toMatchObject({
      status: "completed",
      exitCode: 7,
      stdout: "stdout-value",
      stderr: "stderr-value",
    });
  });

  it("terminates a command at its deadline and reports timeout", async () => {
    const result = await executeRuntimeCommand({
      command: "sleep 5",
      timeoutMs: 50,
      killGraceMs: 25,
    });

    expect(result.status).toBe("timeout");
    expect(result.exitCode).toBeNull();
    expect(result.error).toBe("command timed out after 50ms");
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it("truncates from the middle while retaining the head and tail", () => {
    const output = truncateRuntimeCommandOutput(`HEAD-${"x".repeat(4_096)}-TAIL`, 256);

    expect(output.startsWith("HEAD-")).toBeTrue();
    expect(output.endsWith("-TAIL")).toBeTrue();
    expect(output).toContain("bytes truncated");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(256);
  });
});

describe("runtime command redaction", () => {
  const githubPat = ["ghp", "placeholdervalue1234"].join("_");
  const githubOauth = ["gho", "placeholdervalue5678"].join("_");
  const apiKey = ["sk", "placeholder-value-1234"].join("-");
  const jwt = ["headerpart", "payloadpart", "signaturepart"].join(".");
  const cases = [
    ["GitHub PAT", githubPat],
    ["GitHub OAuth token", githubOauth],
    ["API key", apiKey],
    ["JWT", jwt],
    ["Bearer header", `Authorization: Bearer bearer-placeholder-value`],
    ["password assignment", "password=placeholder-value"],
    ["token assignment", "token='placeholder-value'"],
    ["registry basic auth", "--registry=https://user:placeholder-value@registry.example.test"],
  ] as const;

  for (const [name, value] of cases) {
    it(`redacts ${name}`, () => {
      const redacted = redactRuntimeCommandText(`before ${value} after`);
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).not.toContain("placeholder-value-1234");
      expect(redacted).not.toContain("placeholdervalue1234");
      expect(redacted).not.toContain("placeholdervalue5678");
      expect(redacted).not.toContain("bearer-placeholder-value");
      expect(redacted).not.toContain("user:placeholder-value@");
    });
  }

  it("redacts credentials split across command arguments", () => {
    expect(redactRuntimeCommandArgs([
      "--registry",
      "https://user:placeholder-value@registry.example.test",
      "Authorization:",
      "Bearer",
      "bearer-placeholder-value",
    ])).toEqual([
      "--registry",
      "https://[REDACTED]@registry.example.test",
      "Authorization:",
      "Bearer",
      "[REDACTED]",
    ]);
  });
});
