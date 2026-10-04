import { CliError } from "./errors.js";
import type { CommandSpec } from "./command-registry.js";

/** Single inventory for dispatch, manifests, documentation guards and data rewrites. */
const retiredCommands: Record<string, string> = {
  "task create": "remi message send --to <agent> --kind request",
  "task continue": "remi message send --to <agent> --kind request",
  "session task create": "remi message send <conversation> --to <agent> --kind request",
  "issue rerun": "remi message send <issue> --to issue-owner --kind request",
  "task steer": "remi message send --to <agent> (收尾用 remi turn wrap-up <turn>)",
  "task steer list": "remi message list <conversation> --unread-by <agent>",
  "comment add": "remi message send <conversation>",
  "issue comment add": "remi message send <conversation>",
  "session message create": "remi message send <conversation>",
  "chat message create": "remi message send <conversation>",
  "chat attachment send": "remi message send --attachment <path>",
  "issue decision request": "remi message send --kind decision --option <option>",
  "issue decision answer": "remi message send --reply-to <message> --option <option>",
  "issue decision list": "remi message list <conversation> --kind decision",
  "issue decision escalate": "remi message send --kind decision --to <member>",
  "issue decision withdraw": "remi message delete <message>",
  "task request list": "remi inbox",
  "task request respond": "remi message send --reply-to <message> --option <option>",
  "comment list": "remi message list <conversation>",
  "comment update": "remi message edit <message>",
  "comment delete": "remi message delete <message>",
  "comment resolve": "remi message resolve <message>",
  "comment unresolve": "remi message resolve <message> --no-resolved",
  "comment reaction list": "remi message get <message>",
  "comment reaction add": "remi message react <message> --emoji <emoji>",
  "comment reaction remove": "remi message react <message> --emoji <emoji> --remove",
  "comment attachment list": "remi message get <message>",
  "session log get": "remi message get <message>",
  "session log window": "remi message list <conversation>",
  "session log locate": "remi message get <message>",
  "session event list": "remi message list <conversation>",
  "chat message list": "remi message list <conversation>",
  "chat queue list": "remi message list <conversation> --unread-by <agent>",
  "chat queue update": "remi message edit <message>",
  "chat queue remove": "remi message delete <message>",
  "chat queue clear": "remi message list <conversation> --unread-by <agent> 后逐条 remi message delete <message>",
  "chat queue prioritize": "remi message delete <message> 后重新 remi message send <conversation>（按消息顺序）",
  "chat pending": "remi message list <conversation> --unread-by <agent>",
  "chat read": "remi inbox read <conversation>",
  "inbox list": "remi inbox",
  "inbox page": "remi inbox --limit <n> --cursor <cursor>",
  "inbox summary": "remi inbox",
  "inbox unread-count": "remi inbox",
  "inbox archive": "remi inbox read <conversation>",
  "inbox mark-all-read": "remi inbox read-all",
  "inbox archive-all": "remi inbox read-all",
  "inbox archive-all-read": "remi inbox read-all",
  "inbox archive-completed": "remi inbox read-all",
  "task list": "remi turn list",
  "task get": "remi turn get <turn>",
  "task inspect": "remi turn get <turn> --attempts",
  "task cancel": "remi turn cancel <turn>",
  "task prompt": "remi turn get <turn> --input",
  "task redispatch": "remi turn retry <turn> --cold",
  "task trace read": "remi turn trace read <turn>",
  "task message list": "remi turn trace read <turn>",
  "task messages": "remi turn trace read <turn>",
  "issue run-messages": "remi turn trace read <turn>",
  "issue runs": "remi turn list --issue <issue>",
  "issue active-task": "remi turn list --issue <issue>",
  "issue cancel-task": "remi turn cancel <turn>",
  "session task list": "remi turn list --session <conversation>",
};

// Aliases are separate entries, so no alias warning precedes the removal error.
export const RETIRED_CLI_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  ...retiredCommands,
  ...Object.fromEntries(["list", "update", "delete", "resolve", "unresolve"].map((action) =>
    [`issue comment ${action}`, retiredCommands[`comment ${action}`]!])),
});

export function retiredSpec(path: readonly string[], replacement: string): CommandSpec {
  return {
    id: `retired.${path.join(".")}`, path, description: `已移除：改用 ${replacement}`,
    retired: { replacement }, parse: "passthrough", hidden: true,
    run: async () => { throw new CliError("usage", `已移除：改用 ${replacement}`); },
  };
}

export function assertNotRetired(argv: readonly string[]): void {
  if (argv[0] === "inbox" && argv[1] === "read" && argv[2]?.startsWith("inb_")) {
    throw new CliError("usage", "已移除：改用 remi inbox read <conversation>");
  }
  const path = Object.keys(RETIRED_CLI_COMMANDS).sort((a, b) => b.split(" ").length - a.split(" ").length)
    .find((candidate) => candidate.split(" ").every((segment, i) => argv[i] === segment));
  if (path) throw new CliError("usage", `已移除：改用 ${RETIRED_CLI_COMMANDS[path]}`);
}

export function replaceRetiredSpecs(specs: readonly CommandSpec[]): CommandSpec[] {
  return specs.filter((spec) => !(spec.path.join(" ") in RETIRED_CLI_COMMANDS)
    && !["inbox", "inbox.group", "inbox.read", "task", "comment", "chat.attachment", "chat.queue"].includes(spec.id))
    .map((spec) => ({ ...spec, aliases: spec.aliases?.filter((alias) => !(alias.path.join(" ") in RETIRED_CLI_COMMANDS)) }));
}
