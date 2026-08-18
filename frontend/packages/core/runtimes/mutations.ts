import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { runtimeKeys } from "./queries";
import { runtimeModelsKeys } from "./models";
import { workspaceKeys } from "../workspace/queries";
import { agentTaskSnapshotKeys, agentTasksKeys } from "../agents/queries";
import { agentPluginKeys } from "../plugins/queries";
import { chatKeys } from "../chat/queries";
import { issueKeys } from "../issues/queries";
import type { SshMeshOverview } from "./types";

export function useDeleteRuntime(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runtimeId: string) => api.deleteRuntime(runtimeId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
    },
  });
}

// Cascade-mode counterpart to useDeleteRuntime. The dialog routes here when
// the strict DELETE refused with `runtime_has_active_agents` (or when the
// caller already knows the runtime has active agents and wants to skip the
// pre-flight refusal). Mutation fn returns the server-reported counts so
// the caller can render a richer success toast.
//
// Invalidates runtimes (the list / detail), workspace agents (the cascade
// archives them) and the agent presence snapshot (cascade also cancels
// queued/running tasks). Without the agent-side invalidation the Agents
// page would keep showing the just-archived rows as live until a refetch.
export function useArchiveAgentsAndDeleteRuntime(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      runtimeId,
      expectedActiveAgentIds,
    }: {
      runtimeId: string;
      expectedActiveAgentIds: string[];
    }) => api.archiveAgentsAndDeleteRuntime(runtimeId, expectedActiveAgentIds),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
      qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
      qc.invalidateQueries({ queryKey: agentTaskSnapshotKeys.all(wsId) });
    },
  });
}

// useUpdateRuntime patches editable fields on a runtime (visibility).
// Invalidates the runtime list so the picker disabled-state recomputes.
export function useUpdateRuntime(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      runtimeId,
      patch,
    }: {
      runtimeId: string;
      patch: { visibility?: "private" | "public"; name?: string };
    }) => api.updateRuntime(runtimeId, patch),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
    },
  });
}

export function useRetireDaemon(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      daemonId,
      expectedSnapshot,
      abandonIssueWorkspaces,
    }: {
      daemonId: string;
      expectedSnapshot: string;
      abandonIssueWorkspaces?: boolean;
    }) => api.retireDaemon(
      wsId,
      daemonId,
      expectedSnapshot,
      abandonIssueWorkspaces ?? false,
    ),
    onSettled: (_data, _error, variables) => {
      qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
      qc.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) });
      qc.invalidateQueries({ queryKey: runtimeKeys.daemonInventory(wsId) });
      qc.invalidateQueries({
        queryKey: runtimeKeys.daemonRetirementPlan(wsId, variables.daemonId),
      });
      qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
      qc.invalidateQueries({ queryKey: agentTaskSnapshotKeys.all(wsId) });
      qc.invalidateQueries({ queryKey: agentTasksKeys.all(wsId) });
      qc.invalidateQueries({ queryKey: agentPluginKeys.all(wsId) });
      qc.invalidateQueries({ queryKey: chatKeys.all(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.workspacesAll() });
      qc.invalidateQueries({ queryKey: ["issues", "tasks"] });
      qc.invalidateQueries({ queryKey: ["issues", "sessions"] });
    },
  });
}

export function useSetSshMeshEnabled(wsId: string) {
  const qc = useQueryClient();
  const queryKey = runtimeKeys.sshMesh(wsId);
  return useMutation({
    mutationFn: (enabled: boolean) => api.setSshMeshEnabled(wsId, enabled),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<SshMeshOverview>(queryKey);
      qc.setQueryData<SshMeshOverview>(queryKey, (current) =>
        current ? { ...current, enabled } : current,
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) qc.setQueryData(queryKey, context.previous);
    },
    onSuccess: (overview) => qc.setQueryData(queryKey, overview),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });
}

export function useRotateSshMeshKey(wsId: string) {
  const qc = useQueryClient();
  const queryKey = runtimeKeys.sshMesh(wsId);
  return useMutation({
    mutationFn: () => api.rotateSshMeshKey(wsId),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey });
      qc.setQueryData<SshMeshOverview>(queryKey, (current) =>
        current ? { ...current, rotation_state: "rolling_out" } : current,
      );
    },
    onSuccess: (overview) => qc.setQueryData(queryKey, overview),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });
}

export function useTestSshMeshConnection(wsId: string) {
  const qc = useQueryClient();
  const queryKey = runtimeKeys.sshMesh(wsId);
  return useMutation({
    mutationFn: ({
      sourceDaemonId,
      targetDaemonId,
    }: {
      sourceDaemonId: string;
      targetDaemonId?: string;
    }) => api.testSshMeshConnection(wsId, sourceDaemonId, targetDaemonId),
    onSuccess: (result, variables) => {
      if (!result.request_id || result.probe_revision <= 0) return;
      qc.setQueryData<SshMeshOverview>(queryKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          runtimes: current.runtimes.map((runtime) =>
            runtime.daemon_id === variables.sourceDaemonId
              ? {
                  ...runtime,
                  desired_probe_revision: Math.max(
                    runtime.desired_probe_revision,
                    result.probe_revision,
                  ),
                }
              : runtime,
          ),
        };
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });
}
