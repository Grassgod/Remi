import { readFileSync } from "node:fs";
import {
  CliError,
  ResourceResolver,
  type CliIdentity,
  type CliMutation,
  type CliOptionSpec,
  type CommandAlias,
  type CommandInvocation,
  type CommandSpec,
} from "../core/index.js";
import { parseArgs, type CliOptions } from "../multiremi/options.js";
import {
  multiremiApiUploadFile,
  normalizedAttachmentRecord,
  readAttachmentFiles,
} from "../multiremi/http.js";
import {
  INPUT_OPTIONS,
  PAGE_OPTIONS,
  YES_OPTION,
  clientFor,
  commandOptions,
  encodePath,
  extractRecords,
  integerOption,
  positional,
  queryOptions,
  renderResource,
  requestBody,
  requireConfirmation,
  requiredWorkspace,
  stringOption,
  stringOptions,
} from "./resource-common.js";

const HUMAN_TASK: readonly CliIdentity[] = ["human", "task"];
const HUMAN: readonly CliIdentity[] = ["human"];
const TASK: readonly CliIdentity[] = ["task"];
const DEPRECATED_SINCE = "0.3.0";

const ISSUE_LIST_OPTIONS: readonly CliOptionSpec[] = [
  { name: "status", type: "string", valueName: "status", description: "Issue status filter" },
  { name: "priority", type: "string", valueName: "priority", description: "Issue priority filter" },
  { name: "assignee", type: "string", valueName: "ref", description: "Assignee filter" },
  { name: "assignee-type", type: "string", valueName: "type", description: "Assignee type filter" },
  { name: "project", type: "string", valueName: "project", description: "Project filter" },
  { name: "offset", type: "integer", valueName: "n", description: "Legacy offset" },
  { name: "metadata", type: "string", valueName: "k=v", repeatable: true, description: "Metadata filter" },
  { name: "full-id", type: "boolean", description: "Show complete IDs" },
];

const ISSUE_FIELDS: readonly CliOptionSpec[] = [
  { name: "title", type: "string", valueName: "title", description: "Issue title" },
  { name: "description", type: "string", valueName: "text", description: "Issue description" },
  { name: "description-file", type: "string", valueName: "path|-", description: "Read description from a file or stdin" },
  { name: "description-stdin", type: "boolean", description: "Read description from stdin" },
  { name: "status", type: "string", valueName: "status", description: "Issue status" },
  { name: "priority", type: "string", valueName: "priority", description: "Issue priority" },
  { name: "project", type: "string", valueName: "project", description: "Project ID" },
  { name: "parent", type: "string", valueName: "issue", description: "Parent issue" },
  { name: "assignee", type: "string", valueName: "ref", description: "Assignee reference" },
  { name: "assignee-type", type: "string", valueName: "agent|member|squad", description: "Assignee type" },
  { name: "start-date", type: "string", valueName: "date", description: "Start date" },
  { name: "due-date", type: "string", valueName: "date", description: "Due date" },
  { name: "attachment", type: "string", valueName: "path", repeatable: true, description: "Attachment file" },
  { name: "allow-duplicate", type: "boolean", description: "Allow duplicate issue titles" },
  { name: "use-project-defaults", type: "boolean", description: "Deprecated no-op: the server applies the project's default assignee unless assignee fields are sent" },
  { name: "no-project-defaults", type: "boolean", description: "Create unassigned: do not inherit the project's default assignee" },
];

const ISSUE_CREATE_FIELDS: readonly CliOptionSpec[] = [
  ...ISSUE_FIELDS,
  { name: "no-bind-topic", type: "boolean", description: "Create the Issue without moving the current Feishu topic workspace" },
  { name: "daemon-port", type: "integer", valueName: "port", description: "Local daemon helper port" },
];

const COMMENT_BODY_OPTIONS: readonly CliOptionSpec[] = [
  { name: "content", type: "string", valueName: "text", description: "Comment body", conflictsWith: ["content-file", "content-stdin"] },
  { name: "content-file", type: "string", valueName: "path|-", description: "Read comment body from a file or stdin", conflictsWith: ["content", "content-stdin"] },
  { name: "content-stdin", type: "boolean", description: "Read comment body from stdin", conflictsWith: ["content", "content-file"] },
];

const COMMENT_LIST_OPTIONS: readonly CliOptionSpec[] = [
  { name: "thread", type: "string", valueName: "comment-id", description: "Limit to one thread" },
  { name: "since", type: "string", valueName: "iso", description: "Only newer comments" },
  { name: "tail", type: "integer", valueName: "n", description: "Replies from the end of a thread" },
  { name: "recent", type: "integer", valueName: "n", description: "Recent root threads" },
  { name: "roots-only", type: "boolean", description: "Only root comments" },
  { name: "summary", type: "boolean", description: "Summarize comment bodies" },
  { name: "before", type: "string", valueName: "iso", description: "Composite cursor timestamp" },
  { name: "before-id", type: "string", valueName: "comment-id", description: "Composite cursor ID" },
];

const SESSION_RESULT_OPTIONS: readonly CliOptionSpec[] = [
  { name: "session", aliases: ["session-id"], type: "string", valueName: "session-id", description: "Source Session" },
  { name: "title", type: "string", valueName: "title", description: "Result title" },
  { name: "type", type: "string", valueName: "mr|report|deploy|decision|doc|other", description: "Result kind" },
  { name: "ref", type: "string", valueName: "type:value", repeatable: true, description: "Result citation" },
  ...COMMENT_BODY_OPTIONS,
];

export const BOOTSTRAP_COMPATIBILITY_PATHS = [
  "issue comment list",
  "issue comment add",
  "issue session result publish",
  "issue list",
  "issue get",
  "issue update",
  "attachment download",
] as const;

export function collaborationCommandSpecs(): CommandSpec[] {
  return [
    ...issueCompatibilitySpecs(),
    ...commentCommandSpecs(),
    ...sessionCommandSpecs(),
    ...issueExtendedSpecs(),
    ...shareCommandSpecs(),
    ...labelCommandSpecs(),
    ...chatCommandSpecs(),
    ...taskCommandSpecs(),
  ];
}

function issueCompatibilitySpecs(): CommandSpec[] {
  return [
    legacySpec("issue.list", ["issue", "list"], "List issues", "read", HUMAN_TASK, [], ISSUE_LIST_OPTIONS, ["issue", "list"]),
    legacySpec("issue.get", ["issue", "get"], "Get an issue", "read", HUMAN_TASK, [refPositional("issue")], [], ["issue", "get"]),
    legacySpec("issue.search", ["issue", "search"], "Search issues", "read", HUMAN_TASK, [refPositional("query")], [
      { name: "include-closed", type: "boolean", description: "Include closed issues" },
    ], ["issue", "search"]),
    legacySpec("issue.create", ["issue", "create"], "Create an issue", "write", HUMAN_TASK, [], ISSUE_CREATE_FIELDS, ["issue", "create"]),
    legacySpec("issue.bind-topic", ["issue", "bind-topic"], "Resume a local Feishu topic workspace migration", "write", HUMAN_TASK, [refPositional("issue")], [
      { name: "daemon-port", type: "integer", valueName: "port", description: "Local daemon helper port" },
    ], ["issue", "bind-topic"]),
    legacySpec("issue.update", ["issue", "update"], "Update an issue", "write", HUMAN_TASK, [refPositional("issue")], ISSUE_FIELDS, ["issue", "update"]),
    legacySpec("issue.assign", ["issue", "assign"], "Assign or unassign an issue", "write", HUMAN_TASK, [refPositional("issue")], [
      { name: "to", type: "string", valueName: "ref", description: "Assignee reference" },
      { name: "to-type", type: "string", valueName: "type", description: "Assignee type" },
      { name: "unassign", type: "boolean", description: "Clear the assignee" },
    ], ["issue", "assign"]),
    legacySpec("issue.status", ["issue", "status"], "Change issue status", "write", HUMAN_TASK, [refPositional("issue"), refPositional("status")], [], ["issue", "status"]),
    legacySpec("issue.delete", ["issue", "delete"], "Delete an issue", "destructive", HUMAN_TASK, [refPositional("issue")], [], ["issue", "delete"]),
    nativeSpec("issue.restore", ["issue", "restore"], "Restore an archived issue", "write", HUMAN, [refPositional("issue")], [], async (invocation) => {
      await mutateAndRender(invocation, "POST", `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/restore`, {});
    }),
    legacySpec("issue.rerun", ["issue", "rerun"], "Rerun an issue", "write", HUMAN, [refPositional("issue")], [
      { name: "agent-id", type: "string", valueName: "id", description: "Override agent" },
      { name: "prompt", type: "string", valueName: "text", description: "Override prompt" },
    ], ["issue", "rerun"]),
    legacySpec("issue.retitle", ["issue", "retitle"], "Generate an Issue title with the workspace model gateway", "write", HUMAN_TASK, [refPositional("issue")], [
      { name: "dry-run", type: "boolean", description: "Generate a title without applying it" },
    ], ["issue", "retitle"]),
    legacySpec("issue.cancel", ["issue", "cancel-task"], "Cancel an issue task", "destructive", HUMAN_TASK, [refPositional("task")], [], ["issue", "cancel-task"]),
    legacySpec("issue.task-runs", ["issue", "runs"], "List issue task runs", "read", HUMAN_TASK, [refPositional("issue")], [], ["issue", "runs"]),
    legacySpec("task.messages", ["issue", "run-messages"], "List task execution messages", "read", HUMAN_TASK, [refPositional("task")], [
      { name: "since", type: "integer", valueName: "seq", description: "First sequence number" },
    ], ["issue", "run-messages"]),
  ];
}

function commentCommandSpecs(): CommandSpec[] {
  const commands: Array<[string, string, CliMutation, readonly CliOptionSpec[]]> = [
    ["list", "List issue comments", "read", COMMENT_LIST_OPTIONS],
    ["add", "Add an issue comment", "write", [
      ...COMMENT_BODY_OPTIONS,
      { name: "parent", type: "string", valueName: "comment-id", description: "Parent comment" },
      { name: "attachment", type: "string", valueName: "path", repeatable: true, description: "Attachment file" },
    ]],
    ["update", "Update a comment", "write", COMMENT_BODY_OPTIONS],
    ["delete", "Delete a comment", "destructive", []],
    ["resolve", "Resolve a comment", "write", [
      { name: "actor-type", type: "string", valueName: "type", description: "Resolving actor type" },
      { name: "actor-id", type: "string", valueName: "id", description: "Resolving actor ID" },
    ]],
    ["unresolve", "Unresolve a comment", "write", []],
  ];
  return [
    groupSpec("comment", "Manage issue comments"),
    ...commands.map(([action, description, mutation, options]) => legacySpec(
      `comment.${action}`,
      ["comment", action],
      description,
      mutation,
      HUMAN_TASK,
      [refPositional(action === "list" || action === "add" ? "issue" : "comment")],
      options,
      ["issue", "comment", action],
      [compatAlias(["issue", "comment", action], `remi comment ${action}`)],
    )),
    nativeSpec("comment.reaction.list", ["comment", "reaction", "list"], "List comment reactions", "read", HUMAN_TASK, [refPositional("comment")], [], async (invocation) => {
      await getAndRender(invocation, `/api/multiremi/comments/${encodePath(positional(invocation, 0, "comment"))}/reactions`, ["reactions"]);
    }),
    nativeSpec("comment.reaction.add", ["comment", "reaction", "add"], "Add a comment reaction", "write", HUMAN_TASK, [refPositional("comment")], [emojiOption()], async (invocation) => {
      await mutateAndRender(invocation, "POST", `/api/comments/${encodePath(positional(invocation, 0, "comment"))}/reactions`, { emoji: requiredOption(invocation, "emoji") });
    }),
    nativeSpec("comment.reaction.remove", ["comment", "reaction", "remove"], "Remove a comment reaction", "destructive", HUMAN_TASK, [refPositional("comment")], [emojiOption(), YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "DELETE", `/api/comments/${encodePath(positional(invocation, 0, "comment"))}/reactions`, { emoji: requiredOption(invocation, "emoji") });
    }),
    nativeSpec("comment.attachment.list", ["comment", "attachment", "list"], "List comment attachments", "read", HUMAN_TASK, [refPositional("comment")], [], async (invocation) => {
      await getAndRender(invocation, `/api/multiremi/comments/${encodePath(positional(invocation, 0, "comment"))}/attachments`, ["attachments"]);
    }),
  ];
}

function sessionCommandSpecs(): CommandSpec[] {
  return [
    groupSpec("session", "Manage issue Sessions and published results"),
    legacySpec("session.list", ["session", "list"], "List issue Sessions", "read", HUMAN_TASK, [refPositional("issue")], [], ["issue", "session", "list"], [compatAlias(["issue", "session", "list"], "remi session list")]),
    nativeSpec("session.get", ["session", "get"], "Get an issue Session", "read", HUMAN_TASK, [refPositional("issue"), refPositional("session")], [], async (invocation) => {
      const issue = positional(invocation, 0, "issue");
      await getAndRender(invocation, `/api/issues/${encodePath(issue)}/sessions/${encodePath(positional(invocation, 1, "session"))}`);
    }),
    nativeSpec("session.create", ["session", "create"], "Create an issue Session", "write", HUMAN, [refPositional("issue")], [...INPUT_OPTIONS, ...titleStatusOptions(), discussionOption()], async (invocation) => {
      const body = await requestBody(invocation, {
        title: stringOption(invocation, "title") ?? undefined,
        holds_workspace: invocation.options.discussion === true ? false : undefined,
      });
      await mutateAndRender(invocation, "POST", `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/sessions`, body);
    }),
    nativeSpec("session.update", ["session", "update"], "Update an issue Session", "write", HUMAN, [refPositional("issue"), refPositional("session")], [...INPUT_OPTIONS, ...titleStatusOptions()], async (invocation) => {
      const body = await requestBody(invocation, { title: stringOption(invocation, "title") ?? undefined, status: stringOption(invocation, "status") ?? undefined });
      await mutateAndRender(invocation, "PATCH", sessionPath(invocation), body);
    }),
    nativeSpec("session.participant.list", ["session", "participant", "list"], "List Session participants", "read", HUMAN_TASK, [refPositional("issue"), refPositional("session")], [], async (invocation) => {
      await getAndRender(invocation, `${sessionPath(invocation)}/participants`, ["participants"]);
    }),
    nativeSpec("session.participant.add", ["session", "participant", "add"], "Add a Session participant", "write", HUMAN, [refPositional("issue"), refPositional("session")], [
      { name: "type", type: "string", valueName: "agent|member", description: "Participant type" },
      { name: "id", type: "string", valueName: "id", description: "Participant ID" },
    ], async (invocation) => {
      await mutateAndRender(invocation, "POST", `${sessionPath(invocation)}/participants`, { participant_type: requiredOption(invocation, "type"), participant_id: requiredOption(invocation, "id") });
    }),
    nativeSpec("session.participant.remove", ["session", "participant", "remove"], "Remove a Session participant", "destructive", HUMAN, [refPositional("issue"), refPositional("session"), refPositional("type"), refPositional("participant")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "DELETE", `${sessionPath(invocation)}/participants/${encodePath(positional(invocation, 2, "type"))}/${encodePath(positional(invocation, 3, "participant"))}`);
    }),
    nativeSpec("session.event.list", ["session", "event", "list"], "List Session events", "read", HUMAN_TASK, [refPositional("issue"), refPositional("session")], [], async (invocation) => {
      await getAndRender(invocation, `${sessionPath(invocation)}/events`, ["events"]);
    }),
    nativeSpec("session.message.create", ["session", "message", "create"], "Post a Session message", "write", HUMAN_TASK, [refPositional("issue"), refPositional("session")], [...INPUT_OPTIONS, ...COMMENT_BODY_OPTIONS], async (invocation) => {
      await mutateAndRender(invocation, "POST", `${sessionPath(invocation)}/messages`, await requestBody(invocation, { content: await contentOption(invocation) }));
    }),
    nativeSpec("session.task.list", ["session", "task", "list"], "List Session tasks", "read", HUMAN_TASK, [refPositional("issue"), refPositional("session")], [], async (invocation) => {
      await getAndRender(invocation, `${sessionPath(invocation)}/tasks`, ["tasks"]);
    }),
    nativeSpec("session.task.create", ["session", "task", "create"], "Create a delegated Session task", "write", HUMAN_TASK, [refPositional("issue"), refPositional("session")], [...INPUT_OPTIONS, ...agentPromptOptions()], async (invocation) => {
      await mutateAndRender(invocation, "POST", `${sessionPath(invocation)}/tasks`, await requestBody(invocation, { agent_id: requiredOption(invocation, "agent"), prompt: stringOption(invocation, "prompt") ?? undefined }));
    }),
    legacySpec("session.result.list", ["session", "result", "list"], "List published Session results", "read", HUMAN_TASK, [refPositional("issue")], SESSION_RESULT_OPTIONS, ["issue", "session", "result", "list"], [compatAlias(["issue", "session", "result", "list"], "remi session result list")]),
    legacySpec("session.result.publish", ["session", "result", "publish"], "Publish a reusable Session result", "write", HUMAN_TASK, [refPositional("issue")], SESSION_RESULT_OPTIONS, ["issue", "session", "result", "publish"], [compatAlias(["issue", "session", "result", "publish"], "remi session result publish")]),
    legacySpec("session.archive.list", ["session", "archive", "list"], "List issue Session archives", "read", HUMAN, [refPositional("issue")], [], ["issue", "archive", "list"], [compatAlias(["issue", "archive", "list"], "remi session archive list")]),
    legacySpec("session.archive.status", ["session", "archive", "status"], "Show issue Session archive status", "read", HUMAN, [refPositional("issue")], [], ["issue", "archive", "status"], [compatAlias(["issue", "archive", "status"], "remi session archive status")]),
    legacySpec("session.archive.verify", ["session", "archive", "verify"], "Verify an issue Session archive", "write", HUMAN, [refPositional("issue"), optionalPositional("archive")], [], ["issue", "archive", "verify"], [compatAlias(["issue", "archive", "verify"], "remi session archive verify")]),
    legacySpec("session.archive.retry", ["session", "archive", "retry"], "Retry an issue Session archive", "write", HUMAN, [refPositional("issue"), optionalPositional("archive")], [], ["issue", "archive", "retry"], [compatAlias(["issue", "archive", "retry"], "remi session archive retry")]),
    nativeSpec("session.config.get", ["session", "config", "get"], "Get workspace Session archive settings", "read", HUMAN, [refPositional("workspace")], [], async (invocation) => {
      await getAndRender(invocation, `/api/workspaces/${encodePath(positional(invocation, 0, "workspace"))}/session-archive`);
    }),
    nativeSpec("session.config.update", ["session", "config", "update"], "Update workspace Session archive settings", "write", HUMAN, [refPositional("workspace")], INPUT_OPTIONS, async (invocation) => {
      await mutateAndRender(invocation, "PUT", `/api/workspaces/${encodePath(positional(invocation, 0, "workspace"))}/session-archive`, await requestBody(invocation));
    }),
  ];
}

function issueExtendedSpecs(): CommandSpec[] {
  return [
    nativeSpec("issue.grouped", ["issue", "grouped"], "List issues grouped for planning", "read", HUMAN_TASK, [], ISSUE_LIST_OPTIONS, async (invocation) => {
      await getAndRender(invocation, "/api/issues/grouped", ["groups", "issues"], issueQuery(invocation));
    }),
    nativeSpec("issue.children", ["issue", "children"], "List child issues", "read", HUMAN_TASK, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, "/api/issues/children", ["issues"], { parent_ids: positional(invocation, 0, "issue") });
    }),
    nativeSpec("issue.child-progress", ["issue", "child-progress"], "Show child issue progress", "read", HUMAN_TASK, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, "/api/issues/child-progress", ["progress"], { parent_ids: positional(invocation, 0, "issue") });
    }),
    nativeSpec("issue.timeline", ["issue", "timeline"], "Show an issue timeline", "read", HUMAN_TASK, [refPositional("issue")], [
      { name: "session", type: "string", valueName: "session-id", description: "Session scope" },
    ], async (invocation) => {
      await getAndRender(invocation, `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/timeline`, ["timeline"], { issue_session_id: stringOption(invocation, "session") });
    }),
    nativeSpec("issue.active-task", ["issue", "active-task"], "Show an issue's active task", "read", HUMAN_TASK, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/active-task`);
    }),
    nativeSpec("issue.usage", ["issue", "usage"], "Show issue usage", "read", HUMAN_TASK, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/usage`);
    }),
    nativeSpec("issue.workspace", ["issue", "workspace"], "Show issue worktree state", "read", HUMAN_TASK, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/workspace`);
    }),
    nativeSpec("issue.dependency.list", ["issue", "dependency", "list"], "List issue dependencies", "read", HUMAN_TASK, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, issueSubpath(invocation, "dependencies"), ["dependencies"]);
    }),
    nativeSpec("issue.dependency.add", ["issue", "dependency", "add"], "Add an issue dependency", "write", HUMAN_TASK, [refPositional("issue"), refPositional("dependency")], [
      { name: "type", type: "string", valueName: "blocks|depends_on", description: "Dependency type" },
    ], async (invocation) => {
      await mutateAndRender(invocation, "POST", issueSubpath(invocation, "dependencies"), { dependency_id: positional(invocation, 1, "dependency"), dependency_type: stringOption(invocation, "type") ?? "depends_on" });
    }),
    nativeSpec("issue.dependency.remove", ["issue", "dependency", "remove"], "Remove an issue dependency", "destructive", HUMAN_TASK, [refPositional("issue"), refPositional("dependency")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "DELETE", `${issueSubpath(invocation, "dependencies")}/${encodePath(positional(invocation, 1, "dependency"))}`);
    }),
    nativeSpec("issue.reaction.list", ["issue", "reaction", "list"], "List issue reactions", "read", HUMAN_TASK, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, issueSubpath(invocation, "reactions"), ["reactions"]);
    }),
    nativeSpec("issue.reaction.add", ["issue", "reaction", "add"], "Add an issue reaction", "write", HUMAN_TASK, [refPositional("issue")], [emojiOption()], async (invocation) => {
      await mutateAndRender(invocation, "POST", issueSubpath(invocation, "reactions"), { emoji: requiredOption(invocation, "emoji") });
    }),
    nativeSpec("issue.reaction.remove", ["issue", "reaction", "remove"], "Remove an issue reaction", "destructive", HUMAN_TASK, [refPositional("issue")], [emojiOption(), YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "DELETE", issueSubpath(invocation, "reactions"), { emoji: requiredOption(invocation, "emoji") });
    }),
    nativeSpec("issue.label.list", ["issue", "label", "list"], "List issue labels", "read", HUMAN_TASK, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, issueSubpath(invocation, "labels"), ["labels"]);
    }),
    nativeSpec("issue.label.add", ["issue", "label", "add"], "Add a label to an issue", "write", HUMAN_TASK, [refPositional("issue"), refPositional("label")], [], async (invocation) => {
      await mutateAndRender(invocation, "POST", issueSubpath(invocation, "labels"), { label_id: positional(invocation, 1, "label") });
    }),
    nativeSpec("issue.label.remove", ["issue", "label", "remove"], "Remove a label from an issue", "destructive", HUMAN_TASK, [refPositional("issue"), refPositional("label")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "DELETE", `${issueSubpath(invocation, "labels")}/${encodePath(positional(invocation, 1, "label"))}`);
    }),
    ...issueSubscriberSpecs(),
    ...issueMetadataSpecs(),
    ...issueAttachmentSpecs(),
    nativeSpec("issue.batch-update", ["issue", "batch-update"], "Update multiple issues", "write", HUMAN, [], INPUT_OPTIONS, async (invocation) => {
      await mutateAndRender(invocation, "POST", "/api/issues/batch-update", await requestBody(invocation));
    }),
    nativeSpec("issue.batch-delete", ["issue", "batch-delete"], "Delete multiple issues", "destructive", HUMAN, [], [...INPUT_OPTIONS, YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "POST", "/api/issues/batch-delete", await requestBody(invocation));
    }),
    nativeSpec("issue.quick-create", ["issue", "quick-create"], "Quick-create an issue", "write", HUMAN, [], [...INPUT_OPTIONS, ...ISSUE_FIELDS], async (invocation) => {
      await mutateAndRender(invocation, "POST", "/api/issues/quick-create", await requestBody(invocation, { title: stringOption(invocation, "title") ?? undefined }));
    }),
    nativeSpec("issue.squad-evaluated", ["issue", "squad-evaluated"], "Record squad evaluation", "write", HUMAN_TASK, [refPositional("issue")], INPUT_OPTIONS, async (invocation) => {
      await mutateAndRender(invocation, "POST", issueSubpath(invocation, "squad-evaluated"), await requestBody(invocation));
    }),
  ];
}

function issueSubscriberSpecs(): CommandSpec[] {
  return (["list", "add", "remove"] as const).map((action) => legacySpec(
    `issue.subscriber.${action}`,
    ["issue", "subscriber", action],
    `${capitalize(action)} issue subscribers`,
    action === "list" ? "read" : "write",
    HUMAN_TASK,
    [refPositional("issue")],
    [{ name: "user-id", type: "string", valueName: "member-id", description: "Subscriber member" }],
    ["issue", "subscriber", action],
  ));
}

function issueMetadataSpecs(): CommandSpec[] {
  return (["list", "get", "set", "delete"] as const).map((action) => legacySpec(
    `issue.metadata.${action}`,
    ["issue", "metadata", action],
    `${capitalize(action)} issue metadata`,
    action === "list" || action === "get" ? "read" : action === "delete" ? "destructive" : "write",
    HUMAN_TASK,
    [refPositional("issue")],
    [
      { name: "key", type: "string", valueName: "key", description: "Metadata key" },
      { name: "value", type: "string", valueName: "value", description: "Metadata value" },
      { name: "type", type: "string", valueName: "type", description: "Value type" },
    ],
    ["issue", "metadata", action],
  ));
}

function issueAttachmentSpecs(): CommandSpec[] {
  return [
    nativeSpec("issue.attachment.list", ["issue", "attachment", "list"], "List issue attachments", "read", HUMAN_TASK, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, issueSubpath(invocation, "attachments"), ["attachments"]);
    }),
    nativeSpec("issue.attachment.get", ["issue", "attachment", "get"], "Get attachment metadata", "read", HUMAN_TASK, [refPositional("attachment")], [], async (invocation) => {
      await getAndRender(invocation, `/api/attachments/${encodePath(positional(invocation, 0, "attachment"))}`);
    }),
    attachmentDownloadSpec(),
    legacySpec("issue.attachment.upload", ["issue", "attachment", "upload"], "Upload issue attachments", "write", HUMAN_TASK, [refPositional("issue")], [
      { name: "attachment", type: "string", valueName: "path", repeatable: true, description: "Attachment file" },
    ], [], [], uploadIssueAttachments),
    nativeSpec("issue.attachment.delete", ["issue", "attachment", "delete"], "Delete an attachment", "destructive", HUMAN_TASK, [refPositional("attachment")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "DELETE", `/api/attachments/${encodePath(positional(invocation, 0, "attachment"))}`);
    }),
  ];
}

function attachmentDownloadSpec(): CommandSpec {
  const options = commandOptions(PAGE_OPTIONS, [{
    name: "output-dir",
    type: "string",
    valueName: "dir",
    description: "Destination directory",
    conflictsWith: ["output"],
  }])
    .filter((option) => option.name !== "json")
    .map((option) => option.name === "output"
      ? {
          name: "output",
          type: "string" as const,
          valueName: "file",
          description: "Exact destination file",
          conflictsWith: ["output-dir"],
        }
      : option);
  return {
    id: "issue.attachment.download",
    path: ["attachment", "download"],
    description: "Download an attachment",
    capability: "issue.attachment.download",
    auth: HUMAN_TASK,
    mutation: "read",
    outputs: ["table", "json", "jsonl"],
    positionals: [refPositional("attachment")],
    options,
    aliases: [compatAlias(["issue", "attachment", "download"], "remi attachment download")],
    run: async (invocation) => {
      const { runMultiremi } = await import("../multiremi.js");
      await runMultiremi(["attachment", "download", ...invocation.rawArgs], { programName: "remi multiremi" });
    },
  };
}

function shareCommandSpecs(): CommandSpec[] {
  return [
    groupSpec("share", "Manage and view issue shares"),
    nativeSpec("share.get", ["share", "get"], "Get an issue's active share", "read", HUMAN, [refPositional("issue")], [], async (invocation) => {
      await getAndRender(invocation, `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/share`);
    }),
    nativeSpec("share.create", ["share", "create"], "Create an issue share", "write", HUMAN, [refPositional("issue")], [], async (invocation) => {
      await mutateAndRender(invocation, "POST", `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/share`, {});
    }),
    nativeSpec("share.extend", ["share", "extend"], "Extend an issue share", "write", HUMAN, [refPositional("issue")], [], async (invocation) => {
      await mutateAndRender(invocation, "POST", `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/share/extend`, {});
    }),
    nativeSpec("share.delete", ["share", "delete"], "Revoke an issue share", "destructive", HUMAN, [refPositional("issue")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "DELETE", `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/share`);
    }),
    nativeSpec("share.view", ["share", "view"], "View only the content named by a signed share credential", "read", ["human", "share"], [optionalPositional("token")], [], async (invocation) => {
      const token = positionalOrOption(invocation, 0, "token", "share");
      if (!stringOption(invocation, "share")) throw new CliError("usage", "share view requires --share <signed-token>");
      if (token !== stringOption(invocation, "share")) throw new CliError("usage", "the share path token must match --share");
      await getAndRender(invocation, `/api/shares/${encodePath(token)}`);
    }),
  ];
}

function labelCommandSpecs(): CommandSpec[] {
  return [
    groupSpec("label", "Manage workspace labels"),
    nativeSpec("label.list", ["label", "list"], "List labels", "read", HUMAN_TASK, [], [], async (invocation) => {
      await getAndRender(invocation, "/api/labels", ["labels"], { workspace_id: requiredWorkspace(invocation) });
    }),
    nativeSpec("label.get", ["label", "get"], "Get a label", "read", HUMAN_TASK, [refPositional("label")], [], async (invocation) => {
      const label = await resolveLabel(invocation, positional(invocation, 0, "label"));
      renderResource(invocation, label);
    }),
    nativeSpec("label.create", ["label", "create"], "Create a label", "write", HUMAN, [], [...INPUT_OPTIONS, ...labelOptions()], async (invocation) => {
      await mutateAndRender(invocation, "POST", "/api/labels", await requestBody(invocation, { workspace_id: requiredWorkspace(invocation), name: requiredOption(invocation, "name"), color: stringOption(invocation, "color") ?? undefined }));
    }),
    nativeSpec("label.update", ["label", "update"], "Update a label", "write", HUMAN, [refPositional("label")], [...INPUT_OPTIONS, ...labelOptions()], async (invocation) => {
      const label = await resolveLabel(invocation, positional(invocation, 0, "label"));
      await mutateAndRender(invocation, "PUT", `/api/labels/${encodePath(String(label.id))}`, await requestBody(invocation, { name: stringOption(invocation, "name") ?? undefined, color: stringOption(invocation, "color") ?? undefined }));
    }),
    nativeSpec("label.delete", ["label", "delete"], "Delete a label", "destructive", HUMAN, [refPositional("label")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const label = await resolveLabel(invocation, positional(invocation, 0, "label"));
      await mutateAndRender(invocation, "DELETE", `/api/labels/${encodePath(String(label.id))}`);
    }),
  ];
}

function chatCommandSpecs(): CommandSpec[] {
  const chatFields: readonly CliOptionSpec[] = [
    { name: "title", type: "string", valueName: "title", description: "Chat title" },
    { name: "agent", type: "string", valueName: "agent-id", description: "Chat agent" },
    { name: "status", type: "string", valueName: "status", description: "Chat status" },
  ];
  return [
    groupSpec("chat", "Manage product chat Sessions"),
    nativeSpec("chat.list", ["chat", "list"], "List chats", "read", HUMAN, [], [
      { name: "status", type: "string", valueName: "active|all", description: "Archive filter" },
    ], async (invocation) => {
      await getAndRender(invocation, "/api/chat/sessions", ["sessions"], { workspace_id: requiredWorkspace(invocation), status: stringOption(invocation, "status") });
    }),
    nativeSpec("chat.get", ["chat", "get"], "Get a chat", "read", HUMAN, [refPositional("chat")], [], async (invocation) => {
      const chat = await resolveChat(invocation, positional(invocation, 0, "chat"));
      await getAndRender(invocation, `/api/chat/sessions/${encodePath(String(chat.id))}`);
    }),
    nativeSpec("chat.create", ["chat", "create"], "Create a chat", "write", HUMAN, [], [...INPUT_OPTIONS, ...chatFields], async (invocation) => {
      await mutateAndRender(invocation, "POST", "/api/chat/sessions", await requestBody(invocation, { workspace_id: requiredWorkspace(invocation), title: stringOption(invocation, "title") ?? undefined, agent_id: requiredOption(invocation, "agent") }));
    }),
    nativeSpec("chat.update", ["chat", "update"], "Update a chat", "write", HUMAN, [refPositional("chat")], [...INPUT_OPTIONS, ...chatFields], async (invocation) => {
      const chat = await resolveChat(invocation, positional(invocation, 0, "chat"));
      await mutateAndRender(invocation, "PATCH", `/api/chat/sessions/${encodePath(String(chat.id))}`, await requestBody(invocation, { title: stringOption(invocation, "title") ?? undefined, status: stringOption(invocation, "status") ?? undefined }));
    }),
    groupSpec("chat.issue", "Manage a Chat's bound Issue"),
    nativeSpec("chat.issue.bind", ["chat", "issue", "bind"], "Bind a Chat to an Issue", "write", HUMAN, [refPositional("chat"), refPositional("issue")], [], async (invocation) => {
      const chat = await resolveChat(invocation, positional(invocation, 0, "chat"));
      const issue = await resolveIssue(invocation, positional(invocation, 1, "issue"));
      await mutateAndRender(invocation, "PATCH", `/api/chat/sessions/${encodePath(String(chat.id))}`, { issue_id: issue.id });
    }),
    nativeSpec("chat.issue.unbind", ["chat", "issue", "unbind"], "Unbind a Chat from its Issue", "write", HUMAN, [refPositional("chat")], [], async (invocation) => {
      const chat = await resolveChat(invocation, positional(invocation, 0, "chat"));
      await mutateAndRender(invocation, "PATCH", `/api/chat/sessions/${encodePath(String(chat.id))}`, { issue_id: null });
    }),
    groupSpec("chat.issue.updates", "Manage Issue updates sent to a Chat agent"),
    nativeSpec("chat.issue.updates.get", ["chat", "issue", "updates", "get"], "Show Issue update delivery settings", "read", HUMAN, [refPositional("chat")], [], async (invocation) => {
      const chat = await resolveChat(invocation, positional(invocation, 0, "chat"));
      await getAndRender(invocation, `/api/chat/sessions/${encodePath(String(chat.id))}/issue-updates`);
    }),
    nativeSpec("chat.issue.updates.enable", ["chat", "issue", "updates", "enable"], "Send bound Issue updates to the Chat agent", "write", HUMAN, [refPositional("chat")], [], async (invocation) => {
      const chat = await resolveChat(invocation, positional(invocation, 0, "chat"));
      await mutateAndRender(invocation, "PUT", `/api/chat/sessions/${encodePath(String(chat.id))}/issue-updates`, { enabled: true });
    }),
    nativeSpec("chat.issue.updates.disable", ["chat", "issue", "updates", "disable"], "Stop sending bound Issue updates to the Chat agent", "write", HUMAN, [refPositional("chat")], [], async (invocation) => {
      const chat = await resolveChat(invocation, positional(invocation, 0, "chat"));
      await mutateAndRender(invocation, "PUT", `/api/chat/sessions/${encodePath(String(chat.id))}/issue-updates`, { enabled: false });
    }),
    nativeSpec("chat.delete", ["chat", "delete"], "Delete a chat", "destructive", HUMAN, [refPositional("chat")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const chat = await resolveChat(invocation, positional(invocation, 0, "chat"));
      await mutateAndRender(invocation, "DELETE", `/api/chat/sessions/${encodePath(String(chat.id))}`);
    }),
    nativeSpec("chat.message.list", ["chat", "message", "list"], "List chat messages", "read", HUMAN, [refPositional("chat")], [], async (invocation) => {
      await getAndRender(invocation, `/api/chat/sessions/${encodePath(positional(invocation, 0, "chat"))}/messages/page`, ["messages"], queryOptions(invocation, { limit: integerOption(invocation, "limit") }));
    }),
    nativeSpec("chat.message.create", ["chat", "message", "create"], "Send a chat message", "write", HUMAN, [refPositional("chat")], [...INPUT_OPTIONS, ...COMMENT_BODY_OPTIONS], async (invocation) => {
      await mutateAndRender(invocation, "POST", `/api/chat/sessions/${encodePath(positional(invocation, 0, "chat"))}/messages`, await requestBody(invocation, { content: await contentOption(invocation) }));
    }),
    nativeSpec("chat.pending", ["chat", "pending"], "Show pending chat tasks", "read", HUMAN, [optionalPositional("chat")], [], async (invocation) => {
      const chat = invocation.positionals[0]?.trim();
      await getAndRender(invocation, chat ? `/api/chat/sessions/${encodePath(chat)}/pending-task` : "/api/chat/pending-tasks", ["tasks"]);
    }),
    nativeSpec("chat.read", ["chat", "read"], "Mark a chat as read", "write", HUMAN, [refPositional("chat")], [], async (invocation) => {
      await mutateAndRender(invocation, "POST", `/api/chat/sessions/${encodePath(positional(invocation, 0, "chat"))}/read`, {});
    }),
  ];
}

function taskCommandSpecs(): CommandSpec[] {
  return [
    groupSpec("task", "Manage agent tasks and human requests"),
    nativeSpec("task.list", ["task", "list"], "List tasks", "read", HUMAN_TASK, [], [
      { name: "status", type: "string", valueName: "status", description: "Task status" },
    ], async (invocation) => {
      await getAndRender(invocation, "/api/multiremi/tasks", ["tasks"], { status: stringOption(invocation, "status") });
    }),
    nativeSpec("task.get", ["task", "get"], "Get a task", "read", HUMAN_TASK, [refPositional("task")], [], async (invocation) => {
      await getAndRender(invocation, `/api/multiremi/tasks/${encodePath(positional(invocation, 0, "task"))}`);
    }),
    nativeSpec("task.create", ["task", "create"], "Create a task", "write", HUMAN_TASK, [], [...INPUT_OPTIONS, ...agentPromptOptions(),
      { name: "issue", type: "string", valueName: "issue-id", description: "Related issue" },
      { name: "chat", type: "string", valueName: "chat-id", description: "Related chat" },
    ], async (invocation) => {
      await mutateAndRender(invocation, "POST", "/api/multiremi/tasks", await requestBody(invocation, { agentId: requiredOption(invocation, "agent"), prompt: stringOption(invocation, "prompt") ?? undefined, issueId: stringOption(invocation, "issue") ?? undefined, chatSessionId: stringOption(invocation, "chat") ?? undefined }));
    }),
    nativeSpec("task.cancel", ["task", "cancel"], "Cancel a task", "destructive", HUMAN_TASK, [refPositional("task")], [YES_OPTION,
      { name: "reason", type: "string", valueName: "text", description: "Organizer action criterion" },
    ], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "POST", `/api/tasks/${encodePath(positional(invocation, 0, "task"))}/cancel`, { reason: stringOption(invocation, "reason") ?? undefined });
    }),
    nativeSpec("task.redispatch", ["task", "redispatch"], "Cancel and cold-start a replacement task", "destructive", TASK, [refPositional("task")], [YES_OPTION,
      { name: "reason", type: "string", valueName: "text", description: "Organizer action criterion" },
    ], async (invocation) => {
      requireConfirmation(invocation);
      await mutateAndRender(invocation, "POST", `/api/tasks/${encodePath(positional(invocation, 0, "task"))}/redispatch`, {
        reason: requiredOption(invocation, "reason"),
      });
    }),
    nativeSpec("task.steer", ["task", "steer"], "Send a mid-run directive to a live task", "write", HUMAN_TASK, [refPositional("task")], [
      { name: "content", type: "string", valueName: "text", description: "Directive content", conflictsWith: ["content-file", "content-stdin"] },
      { name: "content-file", type: "string", valueName: "path|-", description: "Read directive from a file or stdin", conflictsWith: ["content", "content-stdin"] },
      { name: "content-stdin", type: "boolean", description: "Read directive from stdin", conflictsWith: ["content", "content-file"] },
      { name: "force-answer", type: "boolean", description: "Ask the agent to wrap up and deliver its best conclusion now" },
      { name: "reason", type: "string", valueName: "text", description: "Organizer action criterion" },
    ], async (invocation) => {
      await mutateAndRender(invocation, "POST", `/api/tasks/${encodePath(positional(invocation, 0, "task"))}/steer`, {
        content: await contentOption(invocation),
        ...(invocation.options["force-answer"] === true ? { force_answer: true } : {}),
        reason: stringOption(invocation, "reason") ?? undefined,
      });
    }),
    nativeSpec("task.steer.list", ["task", "steer", "list"], "List steer directives sent to a task", "read", HUMAN_TASK, [refPositional("task")], [], async (invocation) => {
      await getAndRender(invocation, `/api/tasks/${encodePath(positional(invocation, 0, "task"))}/steer`, ["messages"]);
    }),
    nativeSpec("task.message.list", ["task", "message", "list"], "List task messages", "read", HUMAN_TASK, [refPositional("task")], [
      { name: "since", type: "integer", valueName: "seq", description: "First sequence number" },
    ], async (invocation) => {
      await getAndRender(invocation, `/api/tasks/${encodePath(positional(invocation, 0, "task"))}/messages`, ["messages"], { since: integerOption(invocation, "since") });
    }, [{ path: ["task", "messages"], deprecatedSince: DEPRECATED_SINCE, replacement: "remi task message list" }]),
    nativeSpec("task.inspect", ["task", "inspect"], "Inspect derived task health metadata", "read", HUMAN_TASK, [refPositional("task")], [], async (invocation) => {
      await getAndRender(invocation, `/api/tasks/${encodePath(positional(invocation, 0, "task"))}/inspection`, ["inspection"]);
    }),
    nativeSpec("task.prompt", ["task", "prompt"], "Get a recorded task prompt", "read", HUMAN_TASK, [refPositional("task")], [], async (invocation) => {
      await getAndRender(invocation, `/api/tasks/${encodePath(positional(invocation, 0, "task"))}/prompt`);
    }),
    nativeSpec("task.request.list", ["task", "request", "list"], "List task human requests", "read", HUMAN_TASK, [refPositional("task")], [], async (invocation) => {
      await getAndRender(invocation, `/api/tasks/${encodePath(positional(invocation, 0, "task"))}/human-requests`, ["requests"]);
    }),
    nativeSpec("task.request.respond", ["task", "request", "respond"], "Respond to a task human request", "write", HUMAN_TASK, [refPositional("task"), refPositional("request")], INPUT_OPTIONS, async (invocation) => {
      await mutateAndRender(invocation, "POST", `/api/tasks/${encodePath(positional(invocation, 0, "task"))}/human-requests/${encodePath(positional(invocation, 1, "request"))}/respond`, await requestBody(invocation));
    }),
  ];
}

function legacySpec(
  id: string,
  path: string[],
  description: string,
  mutation: CliMutation,
  auth: readonly CliIdentity[],
  positionals: CommandSpec["positionals"],
  options: readonly CliOptionSpec[],
  prefix: string[],
  aliases: readonly CommandAlias[] = [],
  customRun?: CommandSpec["run"],
): CommandSpec {
  return {
    id,
    path,
    description,
    capability: id,
    auth,
    mutation,
    outputs: ["table", "json", "jsonl"],
    positionals,
    options: commandOptions(options, mutation === "read" ? PAGE_OPTIONS : []),
    aliases,
    parse: "passthrough",
    run: customRun ?? (async (invocation) => {
      const { runMultiremi } = await import("../multiremi.js");
      await runMultiremi([...prefix, ...invocation.rawArgs], { programName: "remi multiremi" });
    }),
  };
}

function nativeSpec(
  id: string,
  path: string[],
  description: string,
  mutation: CliMutation,
  auth: readonly CliIdentity[],
  positionals: CommandSpec["positionals"],
  options: readonly CliOptionSpec[],
  run: CommandSpec["run"],
  aliases: readonly CommandAlias[] = [],
): CommandSpec {
  return {
    id,
    path,
    description,
    capability: id,
    auth,
    mutation,
    outputs: ["table", "json", "jsonl"],
    positionals,
    options: commandOptions(options, mutation === "read" ? PAGE_OPTIONS : []),
    aliases,
    run,
  };
}

function groupSpec(id: string, description: string): CommandSpec {
  return {
    id,
    path: [id],
    description,
    parse: "passthrough",
    run: async () => { throw new CliError("usage", `usage: remi ${id} <command>`); },
  };
}

function compatAlias(path: string[], replacement: string): CommandAlias {
  return { path, deprecatedSince: DEPRECATED_SINCE, replacement, dispatch: false };
}

async function getAndRender(
  invocation: CommandInvocation,
  path: string,
  keys: readonly string[] = [],
  query?: Record<string, string | number | boolean | null | undefined>,
): Promise<void> {
  const client = await clientFor(invocation);
  const response = await client.request({ method: "GET", path, query });
  renderResource(invocation, response.data, keys);
}

async function mutateAndRender(
  invocation: CommandInvocation,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<void> {
  const client = await clientFor(invocation);
  const response = await client.request({ method, path, body });
  renderResource(invocation, response.data ?? { ok: true });
}

async function uploadIssueAttachments(invocation: CommandInvocation): Promise<void> {
  const parsed = parseArgs(["upload", ...invocation.rawArgs]);
  const issueId = parsed.positional[0]?.trim();
  if (!issueId) throw new CliError("usage", "issue attachment upload requires <issue>");
  const files = readAttachmentFiles(parsed.options as CliOptions);
  if (!files.length) throw new CliError("usage", "pass at least one --attachment <path>");
  const uploaded: Record<string, unknown>[] = [];
  for (const file of files) {
    uploaded.push(normalizedAttachmentRecord(await multiremiApiUploadFile(file, issueId, parsed.options)));
    console.error(`Uploaded ${file.path}`);
  }
  renderResource({ ...invocation, options: parsed.options }, uploaded);
}

async function resolveLabel(invocation: CommandInvocation, ref: string): Promise<Record<string, unknown>> {
  const client = await clientFor(invocation);
  const list = async () => {
    const response = await client.request<unknown>({ method: "GET", path: "/api/labels", query: { workspace_id: requiredWorkspace(invocation) } });
    return extractRecords(response.data, ["labels"]);
  };
  return new ResourceResolver<Record<string, unknown>>({
    kind: "label",
    getById: async (id) => (await list()).find((label) => label.id === id) ?? null,
    search: list,
    id: (label) => String(label.id ?? ""),
    name: (label) => typeof label.name === "string" ? label.name : null,
  }).resolve(ref);
}

async function resolveChat(invocation: CommandInvocation, ref: string): Promise<Record<string, unknown>> {
  const client = await clientFor(invocation);
  const list = async () => {
    const response = await client.request<unknown>({ method: "GET", path: "/api/chat/sessions", query: { workspace_id: requiredWorkspace(invocation), status: "all" } });
    return extractRecords(response.data, ["sessions"]);
  };
  return new ResourceResolver<Record<string, unknown>>({
    kind: "chat",
    getById: async (id) => (await list()).find((chat) => chat.id === id) ?? null,
    search: list,
    id: (chat) => String(chat.id ?? ""),
    name: (chat) => typeof chat.title === "string" ? chat.title : typeof chat.name === "string" ? chat.name : null,
  }).resolve(ref);
}

async function resolveIssue(invocation: CommandInvocation, ref: string): Promise<Record<string, unknown>> {
  const client = await clientFor(invocation);
  const response = await client.request<Record<string, unknown>>({
    method: "GET",
    path: `/api/issues/${encodePath(ref)}`,
    query: { workspace_id: requiredWorkspace(invocation) },
  });
  return response.data;
}

async function contentOption(invocation: CommandInvocation): Promise<string | undefined> {
  const inline = invocation.options.content;
  if (typeof inline === "string") return inline;
  const file = stringOption(invocation, "content-file");
  if (file) return readFileSync(file === "-" ? 0 : file, "utf8");
  if (invocation.options["content-stdin"] === true) return readFileSync(0, "utf8");
  return undefined;
}

function sessionPath(invocation: CommandInvocation): string {
  return `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/sessions/${encodePath(positional(invocation, 1, "session"))}`;
}

function issueSubpath(invocation: CommandInvocation, tail: string): string {
  return `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/${tail}`;
}

function issueQuery(invocation: CommandInvocation): Record<string, string | number | boolean | null | undefined> {
  return {
    workspace_id: requiredWorkspace(invocation),
    status: stringOption(invocation, "status"),
    priority: stringOption(invocation, "priority"),
    assignee_id: stringOption(invocation, "assignee"),
    assignee_type: stringOption(invocation, "assignee-type"),
    project_id: stringOption(invocation, "project"),
    limit: integerOption(invocation, "limit"),
    offset: integerOption(invocation, "offset"),
  };
}

function requiredOption(invocation: CommandInvocation, name: string): string {
  const value = stringOption(invocation, name);
  if (!value) throw new CliError("usage", `--${name} is required for ${invocation.spec.path.join(" ")}`);
  return value;
}

function positionalOrOption(invocation: CommandInvocation, index: number, positionalName: string, optionName: string): string {
  return invocation.positionals[index]?.trim() || stringOption(invocation, optionName) || (() => {
    throw new CliError("usage", `<${positionalName}> or --${optionName} is required`);
  })();
}

function refPositional(name: string) { return { name, required: true } as const; }
function optionalPositional(name: string) { return { name, required: false } as const; }
function emojiOption(): CliOptionSpec { return { name: "emoji", type: "string", valueName: "emoji", description: "Reaction emoji" }; }
function titleStatusOptions(): CliOptionSpec[] { return [
  { name: "title", type: "string", valueName: "title", description: "Session title" },
  { name: "status", type: "string", valueName: "status", description: "Session status" },
]; }
function discussionOption(): CliOptionSpec {
  return { name: "discussion", type: "boolean", description: "Create without mounting the shared Issue workspace" };
}
function agentPromptOptions(): CliOptionSpec[] { return [
  { name: "agent", type: "string", valueName: "agent-id", description: "Agent ID" },
  { name: "prompt", type: "string", valueName: "text", description: "Task prompt" },
]; }
function labelOptions(): CliOptionSpec[] { return [
  { name: "name", type: "string", valueName: "name", description: "Label name" },
  { name: "color", type: "string", valueName: "hex", description: "Label color" },
]; }
function capitalize(value: string): string { return value[0]!.toUpperCase() + value.slice(1); }
