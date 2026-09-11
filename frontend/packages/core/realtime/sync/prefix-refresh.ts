import type { QueryClient } from "@tanstack/react-query";
import type { WSMessage } from "../../types/events";
import { getCurrentWsId } from "../../platform/workspace-storage";
import { issueKeys } from "../../issues/queries";
import { projectKeys } from "../../projects/queries";
import { projectDocKeys } from "../../project-docs/queries";
import { pinKeys } from "../../pins/queries";
import { autopilotKeys } from "../../autopilots/queries";
import { runtimeKeys } from "../../runtimes/queries";
import { runtimeModelsKeys } from "../../runtimes/models";
import {
  agentTaskSnapshotKeys,
  agentActivityKeys,
  agentRunCountsKeys,
  agentTasksKeys,
} from "../../agents/queries";
import { scmKeys } from "../../scm/queries";
import { larkKeys } from "../../lark/queries";
import { agentPluginKeys } from "../../plugins/queries";
import { chatKeys } from "../../chat/queries";
import { onInboxInvalidate } from "../../inbox/ws-updaters";
import { workspaceKeys } from "../../workspace/queries";
import type { SyncContext } from "./types";

const PREFIX_REFRESH_DELAY_MS = 100;
const TASK_WORKSPACE_AGGREGATE_REFRESH_DELAY_MS = 3_000;
const TASK_WORKSPACE_AGGREGATE_TIMER_KEY = "task:workspace-aggregates";

export function invalidateSquadMemberStatusQueries(qc: QueryClient, wsId: string): void {
  qc.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      return (
        key[0] === "workspaces" &&
        key[1] === wsId &&
        key[2] === "squads" &&
        key[4] === "members-status"
      );
    },
  });
}

/**
 * The generic `onAny` path: map an event's prefix (`issue:updated` -> `issue`)
 * to a debounced invalidation. Events with a dedicated handler in the
 * per-domain maps are listed in `specificEvents` and skipped here so they
 * aren't invalidated twice.
 */
export function createPrefixRefresh({ qc, authStore }: SyncContext): {
  onAny: (msg: WSMessage) => void;
  dispose: () => void;
} {
  const refreshTaskWorkspaceAggregates = () => {
    const wsId = getCurrentWsId();
    if (!wsId) return;
    qc.invalidateQueries({ queryKey: agentTaskSnapshotKeys.list(wsId) });
    qc.invalidateQueries({ queryKey: agentActivityKeys.last30d(wsId) });
    qc.invalidateQueries({ queryKey: agentRunCountsKeys.last30d(wsId) });
  };

  const refreshMap: Record<string, () => void> = {
    inbox: () => {
      const wsId = getCurrentWsId();
      if (wsId) onInboxInvalidate(qc, wsId);
    },
    agent: () => {
      const wsId = getCurrentWsId();
      if (wsId) {
        qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
        qc.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
        // Squad members status is derived per agent, so any agent
        // change (status flip, archive, runtime swap) needs to refresh the
        // per-squad members-status cache without refetching the static squad
        // list summary.
        invalidateSquadMemberStatusQueries(qc, wsId);
      }
    },
    member: () => {
      const wsId = getCurrentWsId();
      if (wsId) qc.invalidateQueries({ queryKey: workspaceKeys.members(wsId) });
    },
    // workspace:updated is handled by the specific handler below
    // (compares prefixes to decide whether to also invalidate issues).
    // This generic fallback still fires for workspace:deleted (paired
    // with the specific navigation handler) and any future workspace:*
    // events without dedicated handlers.
    workspace: () => {
      qc.invalidateQueries({ queryKey: workspaceKeys.list() });
    },
    skill: () => {
      const wsId = getCurrentWsId();
      if (wsId) qc.invalidateQueries({ queryKey: workspaceKeys.skills(wsId) });
    },
    agent_plugin: () => {
      const wsId = getCurrentWsId();
      if (wsId) {
        qc.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
      }
    },
    project: () => {
      const wsId = getCurrentWsId();
      if (wsId) qc.invalidateQueries({ queryKey: projectKeys.all(wsId) });
    },
    // project_doc:created/updated/deleted — a wiki page or agent memory
    // entry changed (an agent writing knowledge back mid-task is the
    // common case). Prefix-invalidate every doc query in the workspace:
    // the payload's project_id would narrow it, but the onAny path is
    // payload-free and the Wiki tab only ever mounts one project's list.
    project_doc: () => {
      const wsId = getCurrentWsId();
      if (wsId) qc.invalidateQueries({ queryKey: projectDocKeys.all(wsId) });
    },
    squad: () => {
      const wsId = getCurrentWsId();
      if (wsId) {
        qc.invalidateQueries({ queryKey: workspaceKeys.squads(wsId) });
        // squad:deleted triggers assignee transfer — refresh issues too.
        qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
      }
    },
    label: () => {
      // label:created/updated/deleted — also refresh issues, since each
      // issue carries a denormalized snapshot of its labels (rename/recolor
      // /delete on a label needs to flush the chips on every issue showing
      // it).
      const wsId = getCurrentWsId();
      if (wsId) {
        qc.invalidateQueries({ queryKey: ["labels", wsId] });
        qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
      }
    },
    pin: () => {
      const wsId = getCurrentWsId();
      const userId = authStore.getState().user?.id;
      if (wsId && userId) qc.invalidateQueries({ queryKey: pinKeys.all(wsId, userId) });
    },
    daemon: () => {
      const wsId = getCurrentWsId();
      if (wsId) {
        qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
        qc.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) });
        qc.invalidateQueries({ queryKey: runtimeKeys.daemonInventory(wsId) });
        qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
        qc.invalidateQueries({ queryKey: agentTaskSnapshotKeys.all(wsId) });
        qc.invalidateQueries({ queryKey: agentTasksKeys.all(wsId) });
        qc.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
        qc.invalidateQueries({ queryKey: chatKeys.all(wsId) });
        qc.invalidateQueries({ queryKey: issueKeys.workspacesAll() });
        qc.invalidateQueries({ queryKey: ["issues", "tasks"] });
        qc.invalidateQueries({ queryKey: ["issues", "sessions"] });
        // Runtime online/offline transitions move the derived status
        // for every agent that hosts on this runtime, which shifts the
        // working/idle/offline pill on the squad page.
        invalidateSquadMemberStatusQueries(qc, wsId);
      }
    },
    autopilot: () => {
      const wsId = getCurrentWsId();
      if (wsId) qc.invalidateQueries({ queryKey: autopilotKeys.all(wsId) });
    },
    lark_installation: () => {
      const wsId = getCurrentWsId();
      if (wsId) qc.invalidateQueries({ queryKey: larkKeys.installations(wsId) });
    },
    change_request: () => {
      qc.invalidateQueries({ queryKey: scmKeys.changeRequestsAll });
    },
    scm: () => {
      const wsId = getCurrentWsId();
      if (wsId) qc.invalidateQueries({ queryKey: scmKeys.all(wsId) });
    },
    task: () => {
      const wsId = getCurrentWsId();
      if (!wsId) return;
      // Per-agent task list (Activity tab "Recent work"). Prefix match
      // catches every agent's list — the per-agent detail key sits
      // under agentTasks/<wsId>/<agentId>.
      qc.invalidateQueries({ queryKey: agentTasksKeys.all(wsId) });
      qc.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
      // Per-issue task list (issue-detail Execution log). Prefix match
      // across all issues — keeps the contract "any task: event makes
      // every list-of-tasks query stale" so cache stays fresh even
      // when the relevant component isn't currently mounted.
      qc.invalidateQueries({ queryKey: ["issues", "tasks"] });
      // Product Session task cards live under a separate per-Session key.
      qc.invalidateQueries({ queryKey: ["issues", "sessions"] });
      // Per-issue token usage card (issue-detail right rail). Same
      // shape as the tasks invalidation above — any task lifecycle
      // event shifts the aggregated usage numbers.
      qc.invalidateQueries({ queryKey: ["issues", "usage"] });
      // Squad members-status reads the same task lifecycle to flip
      // working ↔ idle for each agent member.
      invalidateSquadMemberStatusQueries(qc, wsId);
    },
  };

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const debouncedRefresh = (key: string, fn: () => void, delayMs = PREFIX_REFRESH_DELAY_MS) => {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn();
      }, delayMs),
    );
  };

  return {
    onAny: (msg) => {
      if (SPECIFIC_EVENTS.has(msg.type)) return;
      const prefix = msg.type.split(":")[0] ?? "";
      const refresh = refreshMap[prefix];
      if (!refresh) return;
      debouncedRefresh(prefix, refresh);
      if (prefix === "task") {
        debouncedRefresh(
          TASK_WORKSPACE_AGGREGATE_TIMER_KEY,
          refreshTaskWorkspaceAggregates,
          TASK_WORKSPACE_AGGREGATE_REFRESH_DELAY_MS,
        );
      }
    },
    dispose: () => {
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}

// Event types handled by specific handlers below -- skip generic refresh
const SPECIFIC_EVENTS = new Set([
  "workspace:updated",
  "issue:updated", "issue:created", "issue:deleted", "issue_labels:changed", "issue_metadata:changed", "inbox:new",
  "comment:created", "comment:updated", "comment:deleted",
  "comment:resolved", "comment:unresolved",
  "activity:created",
  "reaction:added", "reaction:removed",
  "issue_reaction:added", "issue_reaction:removed",
  "subscriber:added", "subscriber:removed",
  "daemon:heartbeat",
  // Chat events are handled explicitly below; do not double-invalidate.
  "chat:message", "chat:done", "chat:session_read", "chat:session_deleted",
  "chat:session_updated", "chat:queue_updated",
  // task:message stays out of the prefix path because it fires per
  // streamed message during a long run — invalidating the snapshot on
  // every message would flood the network. Specific chat handlers below
  // still receive it via ws.on() (a separate subscription channel).
  "task:message",
  // task:completed / task:failed deliberately NOT here. They go through
  // both the task-prefix invalidate (refreshes the agent-task-snapshot
  // cache) AND the chat-specific ws.on() handlers below. The two
  // channels are independent — onAny dispatch and ws.on are separate
  // subscriptions.
]);
