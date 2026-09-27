/**
 * Credentials must not reach a log line or a thrown message (MUL-439).
 *
 * Independent review flagged one concrete instance — the read-pool test's skip
 * message printed the whole `MULTIREMI_TEST_POSTGRES_URL` — and the same class
 * of mistake is available anywhere error text from a driver is logged. This
 * covers the shared scrubber those paths use, so a new log site can call one
 * function instead of re-deriving the rule.
 */
import { describe, expect, test } from "bun:test";
import { scrubCredentials, scrubErrorForLog } from "@multiremi/store/db/dsn-redaction.js";

describe("scrubCredentials", () => {
  test("removes the userinfo from a DSN, keeping host and database readable", () => {
    expect(scrubCredentials("connect to postgres://svc:hunter2@db.internal:5432/multiremi failed")).toBe(
      "connect to postgres://***@db.internal:5432/multiremi failed",
    );
  });

  test("removes a userinfo with no password", () => {
    expect(scrubCredentials("postgres://svc@db.internal:5432/multiremi")).toBe(
      "postgres://***@db.internal:5432/multiremi",
    );
  });

  test("removes a password that itself contains an @", () => {
    // Unencoded `@` in a password is accepted by libpq, so the match has to run
    // to the last `@` of the authority rather than the first.
    expect(scrubCredentials("postgresql://svc:pa@ss@db.internal:5432/multiremi")).toBe(
      "postgresql://***@db.internal:5432/multiremi",
    );
  });

  test("removes a percent-encoded password", () => {
    expect(scrubCredentials("postgres://u:pa%40ss%3Aword@h:5432/d")).toBe("postgres://***@h:5432/d");
  });

  test("handles every scheme the config accepts, plus libpq's keyword form", () => {
    expect(scrubCredentials("mysql://u:p@h/d")).toBe("mysql://***@h/d");
    expect(scrubCredentials("postgres://u:p@h/d")).toBe("postgres://***@h/d");
    expect(scrubCredentials("postgresql://u:p@h/d")).toBe("postgresql://***@h/d");
  });

  test("scrubs secret-shaped key/value pairs, keeping the original separators", () => {
    expect(scrubCredentials("password=hunter2 host=db")).toBe("password=*** host=db");
    // Underscore-prefixed names are exactly how a leaked env var arrives.
    expect(scrubCredentials("MULTIREMI_TOKEN=tok_abc123")).toBe("MULTIREMI_TOKEN=***");
    // A quoted value with a space; the `:` separator is preserved.
    expect(scrubCredentials(`sslpassword: "se cret"`)).toBe(`sslpassword: ***`);
    // A name that merely contains one of the keys is not a credential.
    expect(scrubCredentials("password_hint=none")).toBe("password_hint=none");
    expect(scrubCredentials("token_count=3")).toBe("token_count=3");
  });

  test("leaves text with nothing to hide untouched", () => {
    // Including a bare host:port, which is exactly what the pool's own
    // messages should read like.
    for (const text of [
      "read pool connection closed with error: Connection closed",
      "db.internal:5432/multiremi",
      "SELECT (42 chars)",
      "",
    ]) {
      expect(scrubCredentials(text)).toBe(text);
    }
  });

  test("scrubs every DSN in a multi-line message, not just the first", () => {
    const text = "a postgres://u1:p1@h1/d1\nb postgres://u2:p2@h2/d2";
    const scrubbed = scrubCredentials(text);
    expect(scrubbed).not.toContain("p1");
    expect(scrubbed).not.toContain("p2");
    expect(scrubbed).toBe("a postgres://***@h1/d1\nb postgres://***@h2/d2");
  });

  test("is idempotent, so a scrubbed message can be logged again safely", () => {
    const once = scrubCredentials("postgres://u:p@h/d password=x");
    expect(scrubCredentials(once)).toBe(once);
  });
});

describe("scrubErrorForLog", () => {
  test("takes the message off an Error and scrubs it", () => {
    expect(scrubErrorForLog(new Error("connect postgres://svc:pw@h/d failed"))).toBe(
      "connect postgres://***@h/d failed",
    );
  });

  test("accepts a thrown non-Error", () => {
    expect(scrubErrorForLog("postgres://svc:pw@h/d")).toBe("postgres://***@h/d");
    expect(scrubErrorForLog(undefined)).toBe("undefined");
  });

  test("does not include the stack", () => {
    // A stack is longer and no more useful in a warn line; more importantly it
    // would carry the frames' own text past the scrubber's view of the message.
    const error = new Error("postgres://svc:pw@h/d");
    expect(scrubErrorForLog(error)).not.toContain("at ");
  });
});
