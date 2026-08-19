import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { sessionArchiveKeys } from "./queries";

export function useVerifyIssueSessionArchive(issueId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (archiveId: string) =>
      api.verifyIssueSessionArchive(issueId, archiveId),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionArchiveKeys.issueList(issueId),
      });
    },
  });
}

export function useRetryIssueSessionArchive(issueId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (archiveId: string) =>
      api.retryIssueSessionArchive(issueId, archiveId),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionArchiveKeys.issueList(issueId),
      });
    },
  });
}
