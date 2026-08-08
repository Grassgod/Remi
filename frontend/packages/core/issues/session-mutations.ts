import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "./queries";
import type { IssueSession, IssueSessionTask, SessionResult } from "../types";

// ---------------------------------------------------------------------------
// Issue sessions — the parallel tracks an issue is worked on in, plus the
// tasks and published results that hang off them.
// ---------------------------------------------------------------------------

export function useCreateIssueSession(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ title }: { title: string }) => api.createIssueSession(issueId, title),
    onSuccess: (session) => {
      if (!session.id) return;
      qc.setQueryData<IssueSession[]>(issueKeys.sessions(issueId), (old = []) => {
        if (old.some((item) => item.id === session.id)) return old;
        return [...old, session];
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.sessions(issueId) });
    },
  });
}

export function useAddSessionParticipant(issueId: string, issueSessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      participantType,
      participantId,
    }: {
      participantType: "agent" | "member";
      participantId: string;
    }) => api.addSessionParticipant(issueId, issueSessionId, participantType, participantId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.sessions(issueId) });
    },
  });
}

export function useCreateSessionTask(issueId: string, issueSessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, prompt }: { agentId: string; prompt: string }) =>
      api.createSessionTask(issueId, issueSessionId, agentId, prompt),
    onSuccess: (task) => {
      if (!task.id) return;
      qc.setQueryData<IssueSessionTask[]>(
        issueKeys.sessionTasks(issueId, issueSessionId),
        (old = []) => old.some((item) => item.id === task.id) ? old : [...old, task],
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.sessionTasks(issueId, issueSessionId) });
      qc.invalidateQueries({ queryKey: issueKeys.sessions(issueId) });
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId, issueSessionId) });
    },
  });
}

export function usePublishSessionResult(issueId: string, issueSessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ title, body }: { title: string; body: string }) =>
      api.publishSessionResult(issueId, issueSessionId, title, body),
    onSuccess: (result) => {
      if (!result.id) return;
      qc.setQueryData<SessionResult[]>(issueKeys.sessionResults(issueId), (old = []) => {
        if (old.some((item) => item.id === result.id)) return old;
        return [...old, result];
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: issueKeys.sessionResults(issueId) });
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId, issueSessionId) });
    },
  });
}
