/**
 * Feishu slash-command parsing (MUL-358).
 *
 * The Feishu client's CoT "stop" control sends an ordinary IM text as the user,
 * so these rules decide whether a message is a command or new work.
 */

import { describe, expect, it } from "bun:test";
import {
  isUnknownFeishuCommand,
  resolveFeishuCommand,
  unknownCommandMessage,
} from "../../../apps/remi/cli/feishu-commands.js";

describe("resolveFeishuCommand", () => {
  it("recognises stop and its /esc alias", () => {
    expect(resolveFeishuCommand("/stop")).toMatchObject({ name: "stop", args: "" });
    expect(resolveFeishuCommand("/esc")).toMatchObject({ name: "esc", args: "" });
    expect(resolveFeishuCommand("/STOP")).toMatchObject({ name: "stop" });
    expect(resolveFeishuCommand("  /Stop  ")).toMatchObject({ name: "stop" });
  });

  it("matches the mention-stripped body the connector records", () => {
    // `stripBotMention` turns the group form `@Remi /stop` into `/stop`, so the
    // group rendering of the stop button resolves exactly like the private one.
    expect(resolveFeishuCommand("@Remi /stop")).toBeNull();
    expect(resolveFeishuCommand("/stop")).toMatchObject({ name: "stop" });
  });

  it("keeps the existing command table working", () => {
    for (const name of ["new", "status", "sessions", "context", "cwd", "compact"]) {
      expect(resolveFeishuCommand(`/${name}`)).toMatchObject({ name });
    }
  });

  it("carries an explicit disambiguation target as args", () => {
    expect(resolveFeishuCommand("/stop tsk_abc123")).toMatchObject({ name: "stop", args: "tsk_abc123" });
    expect(resolveFeishuCommand("/stop   MUL-358  ")).toMatchObject({ name: "stop", args: "MUL-358" });
  });

  it("leaves ordinary messages alone", () => {
    expect(resolveFeishuCommand("hello")).toBeNull();
    expect(resolveFeishuCommand("/data00/home/x 看下")).toBeNull();
    expect(resolveFeishuCommand("/help 怎么用")).toBeNull();
    expect(resolveFeishuCommand("")).toBeNull();
    expect(resolveFeishuCommand(null)).toBeNull();
    expect(resolveFeishuCommand(undefined)).toBeNull();
  });

  it("ignores the group speaker and quoted-reply prefixes the connector adds", () => {
    // These prefixes live in `message.text`, not in `rawContent`; a command
    // matcher fed the presentation text must not treat it as a command.
    expect(resolveFeishuCommand("贺华杰: /stop")).toBeNull();
    expect(resolveFeishuCommand('[Replying to: "@_user_1 /stop"]\n\n/stop')).toBeNull();
  });
});

describe("isUnknownFeishuCommand", () => {
  it("flags only bare single-token slash messages", () => {
    expect(isUnknownFeishuCommand("/clear")).toBe(true);
    expect(isUnknownFeishuCommand("/foo")).toBe(true);
    expect(isUnknownFeishuCommand("/FOO")).toBe(true);
    expect(isUnknownFeishuCommand("/stop")).toBe(false);
    expect(isUnknownFeishuCommand("/new")).toBe(false);
  });

  it("does not flag slash-prefixed requests that carry arguments or a path", () => {
    expect(isUnknownFeishuCommand("/data00/home/x 看下")).toBe(false);
    expect(isUnknownFeishuCommand("/help 怎么用")).toBe(false);
    expect(isUnknownFeishuCommand("/a/b")).toBe(false);
    expect(isUnknownFeishuCommand("贺华杰: /clear")).toBe(false);
    expect(isUnknownFeishuCommand("")).toBe(false);
  });

  it("names the command and the supported set in the hint", () => {
    const message = unknownCommandMessage("/clear");
    expect(message).toContain("/clear");
    expect(message).toContain("/stop");
    expect(message).toContain("/new");
  });
});
