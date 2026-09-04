import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  FeishuBotRegistrationBrand,
  FeishuBotTestRequest,
  UpdateIssueTopicConfigRequest,
  UpsertFeishuBotRequest,
} from "../types";
import { feishuBotKeys } from "./queries";

/**
 * Every write here changes the config row *and* the derived status, and the
 * two are separate queries. Invalidating the whole `feishu-bot` subtree keeps
 * them from disagreeing — a saved Runtime change with a stale status badge is
 * exactly the kind of drift that makes an admin redeploy a healthy bot.
 */
function invalidateBot(queryClient: QueryClient, workspaceId: string): void {
  void queryClient.invalidateQueries({ queryKey: feishuBotKeys.all(workspaceId) });
}

/**
 * These mutations are deliberately **not** optimistic. The request body carries
 * a secret the cache must never hold, and the server owns the derived status,
 * the revision, and the secret hint. Writing a guess into the cache would mean
 * inventing values only the server can compute.
 */
export function useSaveFeishuBot(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertFeishuBotRequest) => api.saveFeishuBot(workspaceId, input),
    onSettled: () => invalidateBot(queryClient, workspaceId),
  });
}

export function useSaveIssueTopicConfig(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateIssueTopicConfigRequest) => api.saveIssueTopicConfig(workspaceId, input),
    onSettled: () => invalidateBot(queryClient, workspaceId),
  });
}

export function useDeleteFeishuBot(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteFeishuBot(workspaceId),
    onSettled: () => invalidateBot(queryClient, workspaceId),
  });
}

export function useDeployFeishuBot(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.deployFeishuBot(workspaceId),
    onSettled: () => invalidateBot(queryClient, workspaceId),
  });
}

export function useStopFeishuBot(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.stopFeishuBot(workspaceId),
    onSettled: () => invalidateBot(queryClient, workspaceId),
  });
}

/**
 * Testing can record a result against the stored config (the server only does
 * so when the probed credentials match the saved ones), so it invalidates too.
 */
export function useTestFeishuBot(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FeishuBotTestRequest = {}) => api.testFeishuBot(workspaceId, input),
    onSettled: () => invalidateBot(queryClient, workspaceId),
  });
}

export function useBeginFeishuBotRegistration(workspaceId: string) {
  return useMutation({
    mutationFn: (brand: FeishuBotRegistrationBrand) =>
      api.beginFeishuBotRegistration(workspaceId, brand),
  });
}

export function useCancelFeishuBotRegistration(workspaceId: string) {
  return useMutation({
    mutationFn: (sessionId: string) => api.cancelFeishuBotRegistration(workspaceId, sessionId),
  });
}
