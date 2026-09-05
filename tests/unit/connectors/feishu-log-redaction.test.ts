import { describe, expect, it } from "bun:test";
import {
  hashIdentifier,
  redactFeishuError,
} from "@connectors/feishu/log-redaction.js";

describe("Feishu connector error redaction", () => {
  it("preserves diagnostic detail while hashing identifiers and removing credentials", () => {
    const identifiers = [
      "ou_sensitive_user",
      "on_sensitive_union",
      "oc_sensitive_chat",
      "om_sensitive_message",
      "cli_sensitive_app",
      "ma_sensitive_card",
    ];
    const appSecret = "sensitive-app-secret";
    const error = new TypeError(
      `request failed for ${identifiers.join(" ")} credential echo ${appSecret} authorization=Bearer bearer-secret ${"detail ".repeat(80)}`,
    );

    const redacted = redactFeishuError(error, [appSecret]);

    expect(redacted).toContain("TypeError: request failed");
    for (const identifier of identifiers) {
      expect(redacted).toContain(`<id:${hashIdentifier(identifier)}>`);
      expect(redacted).not.toContain(identifier);
    }
    expect(redacted).not.toContain(appSecret);
    expect(redacted).not.toContain("bearer-secret");
    expect(redacted.length).toBeLessThanOrEqual(300);
    expect(redacted).toEndWith("...");
  });
});
