import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "./queries";
import type { CreateIssueSessionRequest, IssueSession } from "../types";

// ---------------------------------------------------------------------------
// Issue sessions — the parallel tracks an issue is worked on in, and who
// takes part in them. Session tasks and published results are written by
// agents through the CLI, so the dashboard only ever reads those.
// ---------------------------------------------------------------------------

export function useCreateIssueSession(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIssueSessionRequest) => api.createIssueSession(issueId, input),
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
