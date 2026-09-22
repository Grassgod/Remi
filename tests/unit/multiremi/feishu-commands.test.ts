/**
 * Feishu slash-command parsing (MUL-358).
 *
 * The Feishu client's CoT "stop" control sends an ordinary IM text as the user,
 * so these rules decide whether a message is a command or new work.
 */

import { describe, expect, it } from "bun:test";
import {
  FEISHU_COMMANDS,
  isUnknownFeishuCommand,
  resolveFeishuCommand,
  unknownCommandMessage,
} from "../../../apps/remi/cli/feishu-commands.js";

describe("resolveFeishuCommand", () => {
  it("recognises /stop regardless of case or surrounding whitespace", () => {
    expect(resolveFeishuCommand("/stop")).toMatchObject({ name: "stop", args: "" });
    expect(resolveFeishuCommand("/STOP")).toMatchObject({ name: "stop" });
    expect(resolveFeishuCommand("  /Stop  ")).toMatchObject({ name: "stop" });
  });

  it("no longer treats retired names as commands", () => {
    // The table is deliberately three entries. These were aliases or separate
    // cards before; now they are answered by the unrecognised-command hint.
    for (const retired of ["esc", "sessions", "context", "cwd", "compact"]) {
      expect(resolveFeishuCommand(`/${retired}`)).toBeNull();
      expect(isUnknownFeishuCommand(`/${retired}`)).toBe(true);
    }
  });

  it("matches the mention-stripped body the connector records", () => {
    // `stripBotMention` turns the group form `@Remi /stop` into `/stop`, so the
    // group rendering of the stop button resolves exactly like the private one.
    expect(resolveFeishuCommand("@Remi /stop")).toBeNull();
    expect(resolveFeishuCommand("/stop")).toMatchObject({ name: "stop" });
  });

  it("keeps exactly the three supported commands", () => {
    for (const name of ["stop", "new", "status"]) {
      expect(resolveFeishuCommand(`/${name}`)).toMatchObject({ name });
    }
    expect(FEISHU_COMMANDS).toEqual(["stop", "new", "status"]);
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

  it("names the command and the supported set in Chinese", () => {
    const message = unknownCommandMessage("/clear");
    expect(message).toContain("不支持的命令 /clear");
    expect(message).toContain("没有启动任何任务");
    expect(message).toContain("可用命令：/stop /new /status");
    // Nothing was started, and no English text leaks into the card.
    expect(message).not.toContain("Unsupported");
    expect(message).not.toContain("Available");
  });
});
