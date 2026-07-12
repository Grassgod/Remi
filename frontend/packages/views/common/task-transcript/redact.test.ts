import { describe, it, expect } from "vitest";
import { redactSecrets, redactString, redactValue } from "./redact";

describe("redactSecrets", () => {
  it("redacts AWS access key", () => {
    const result = redactSecrets("key: AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("[REDACTED AWS KEY]");
  });

  it("redacts AWS secret key", () => {
    const result = redactSecrets("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(result).not.toContain("wJalrXUtnFEMI");
  });

  it("redacts PEM private keys", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";
    const result = redactSecrets(input);
    expect(result).not.toContain("MIIEow");
    expect(result).toContain("[REDACTED PRIVATE KEY]");
  });

  it("redacts GitHub tokens", () => {
    const result = redactSecrets("GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn");
    expect(result).not.toContain("ghp_");
  });

  it("redacts GitLab tokens", () => {
    const result = redactSecrets("glpat-AbCdEfGhIjKlMnOpQrStUvWx");
    expect(result).not.toContain("glpat-");
    expect(result).toContain("[REDACTED GITLAB TOKEN]");
  });

  it("redacts OpenAI/Anthropic API keys", () => {
    const result = redactSecrets("sk-proj-abc123def456ghi789jkl012mno345");
    expect(result).not.toContain("sk-proj");
    expect(result).toContain("[REDACTED API KEY]");
  });

  it("redacts Slack tokens", () => {
    const result = redactSecrets("xoxb-123456789012-1234567890123-AbCdEfGhIjKl");
    expect(result).not.toContain("xoxb-");
  });

  it("redacts JWT tokens", () => {
    const result = redactSecrets("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(result).not.toContain("eyJhbGci");
    expect(result).toContain("[REDACTED JWT]");
  });

  it("redacts Bearer tokens", () => {
    const result = redactSecrets("Authorization: Bearer abc123xyz.def456");
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).not.toContain("abc123xyz");
  });

  it("redacts connection strings", () => {
    const result = redactSecrets("postgres://admin:s3cret@db.example.com:5432/mydb");
    expect(result).not.toContain("s3cret");
  });

  it("redacts generic credential env vars", () => {
    for (const key of ["PASSWORD", "SECRET", "TOKEN", "DATABASE_URL", "API_KEY"]) {
      const result = redactSecrets(`${key}=supersecretvalue123`);
      expect(result).toContain("[REDACTED CREDENTIAL]");
      expect(result).not.toContain("supersecretvalue123");
    }
  });

  it("redacts multiple secrets in one string", () => {
    const result = redactSecrets("AKIAIOSFODNN7EXAMPLE and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("ghp_");
  });

  it("does not alter normal text", () => {
    const inputs = [
      "This is a normal commit message about fixing a bug",
      "The function returns skip-navigation as the class name",
      "Created PR #42 for the authentication feature",
      "Running tests in /tmp/test-workspace/project",
      "The API endpoint /api/issues/123 was updated",
    ];
    for (const input of inputs) {
      expect(redactSecrets(input)).toBe(input);
    }
  });
});

describe("redactString home-path privatization", () => {
  it("masks the username in Unix home paths", () => {
    expect(redactString("/home/alice/project/a.ts")).toBe("/home/<user>/project/a.ts");
    expect(redactString("/Users/bob/repo")).toBe("/Users/<user>/repo");
  });

  it("masks Windows home paths", () => {
    expect(redactString("C:\\Users\\carol\\code")).toBe("C:\\Users\\<user>\\code");
  });

  it("leaves non-home paths untouched", () => {
    expect(redactString("/tmp/scratch/x")).toBe("/tmp/scratch/x");
  });
});

describe("redactValue recursive key-aware masking", () => {
  it("masks values under sensitive key names the string patterns miss", () => {
    // {"api_key":"raw"} has no KEY=value text, so redactSecrets alone can't see it.
    expect(redactValue({ api_key: "raw-value", note: "fine" })).toEqual({
      api_key: "[REDACTED CREDENTIAL]",
      note: "fine",
    });
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactValue({ env: [{ SECRET_TOKEN: "x" }], path: "/home/dan/w" });
    expect(out).toEqual({ env: [{ SECRET_TOKEN: "[REDACTED CREDENTIAL]" }], path: "/home/<user>/w" });
  });

  it("still redacts secret-shaped leaf strings", () => {
    expect(redactValue({ msg: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" }))
      .toEqual({ msg: expect.not.stringContaining("ghp_") });
  });

  it("is cycle safe", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    const out = redactValue(a) as Record<string, unknown>;
    expect(out.x).toBe(1);
    expect(out.self).toBe("[REDACTED CYCLE]");
  });
});
