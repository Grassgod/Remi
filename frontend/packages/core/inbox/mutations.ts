import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { inboxKeys } from "./queries";
import { useWorkspaceId } from "../hooks";

// Wait for the authoritative cursor; a failed write must leave unread messages visible.
export function useMarkInboxRead() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    onMutate: () => ({ wsId }),
    mutationFn: (input: { session_id: string; to_seq?: number }) => api.markInboxRead(input),
    onSuccess: (_data, _input, context) => qc.invalidateQueries({ queryKey: inboxKeys.all(context.wsId) }),
  });
}
export function useMarkAllInboxRead() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({ onMutate: () => ({ wsId }), mutationFn: () => api.markAllInboxRead(), onSuccess: (_data, _input, context) => qc.invalidateQueries({ queryKey: inboxKeys.all(context.wsId) }) });
}
