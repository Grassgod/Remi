import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  FeishuIssueInput,
  FeishuMessageConnectionInput,
  FeishuSourceInput,
} from "../api/endpoints/feishu";
import { inboxKeys } from "../inbox/queries";
import { feishuKeys } from "./queries";

/** Acting on a message settles its Inbox row too — approving a proposal or
 *  ignoring a message removes the row the user is looking at. Invalidating only
 *  the Feishu cache would leave a stale, un-actionable row in the inbox. */
function invalidateMessageCaches(queryClient: QueryClient, workspaceId: string): void {
  void queryClient.invalidateQueries({ queryKey: feishuKeys.all(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: inboxKeys.all(workspaceId) });
}

/** Re-checks one connection on demand and refreshes the whole panel: a
 *  connection that just came back also unblocks every source pointing at it. */
export function useCheckFeishuEndpoint(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.checkFeishuEndpoint(workspaceId, name),
    onSettled: () => queryClient.invalidateQueries({ queryKey: feishuKeys.all(workspaceId) }),
  });
}

export function useCreateFeishuMessageConnection(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FeishuMessageConnectionInput) => api.createFeishuMessageConnection(workspaceId, input),
    // The mutation variables contain App Secret. Once its observer resets,
    // remove the completed mutation immediately instead of retaining it in
    // the default cache window.
    gcTime: 0,
    onSettled: () => queryClient.invalidateQueries({ queryKey: feishuKeys.all(workspaceId) }),
  });
}

export function useBeginFeishuMessageAuthorization(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => api.beginFeishuMessageAuthorization(workspaceId, connectionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: feishuKeys.all(workspaceId) }),
  });
}

export function useCreateFeishuSource(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FeishuSourceInput) => api.createFeishuSource(workspaceId, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: feishuKeys.all(workspaceId) }),
  });
}

export function useUpdateFeishuSource(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, input }: { sourceId: string; input: FeishuSourceInput }) =>
      api.updateFeishuSource(workspaceId, sourceId, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: feishuKeys.all(workspaceId) }),
  });
}

export function useDeleteFeishuSource(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => api.deleteFeishuSource(workspaceId, sourceId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: feishuKeys.all(workspaceId) }),
  });
}

export function useResolveFeishuMessage(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, outcome, reason }: { messageId: string; outcome: string; reason?: string }) =>
      api.resolveFeishuMessage(workspaceId, messageId, { outcome, reason }),
    onSettled: () => invalidateMessageCaches(queryClient, workspaceId),
  });
}

export function useNotifyFeishuMessage(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, summary }: { messageId: string; summary: string }) =>
      api.notifyFeishuMessage(workspaceId, messageId, summary),
    onSettled: () => invalidateMessageCaches(queryClient, workspaceId),
  });
}

/** Stores a reply draft as an Inbox item. Nothing is sent to Feishu here, by
 *  design — the send path stays human-approved and outside this feature. */
export function useDraftFeishuMessageReply(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, draftText }: { messageId: string; draftText: string }) =>
      api.draftFeishuMessageReply(workspaceId, messageId, draftText),
    onSettled: () => invalidateMessageCaches(queryClient, workspaceId),
  });
}

export function useProposeFeishuMessageIssue(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, input }: { messageId: string; input: FeishuIssueInput }) =>
      api.proposeFeishuMessageIssue(workspaceId, messageId, input),
    onSettled: () => invalidateMessageCaches(queryClient, workspaceId),
  });
}

export function useApproveFeishuProposal(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) => api.approveFeishuProposal(workspaceId, proposalId),
    onSettled: () => invalidateMessageCaches(queryClient, workspaceId),
  });
}

export function useRejectFeishuProposal(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) => api.rejectFeishuProposal(workspaceId, proposalId),
    onSettled: () => invalidateMessageCaches(queryClient, workspaceId),
  });
}
