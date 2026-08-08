import type {
  GitHubConnectResponse,
  GitHubPullRequest,
  ListGitHubInstallationsResponse,
} from "../../types";
import type { HttpClient } from "../http";

export class GitHubEndpoints {
  constructor(readonly http: HttpClient) {}

  // GitHub integration
  async getGitHubConnectURL(workspaceId: string): Promise<GitHubConnectResponse> {
    return this.http.fetch(`/api/workspaces/${workspaceId}/github/connect`);
  }

  async listGitHubInstallations(workspaceId: string): Promise<ListGitHubInstallationsResponse> {
    return this.http.fetch(`/api/workspaces/${workspaceId}/github/installations`);
  }

  async deleteGitHubInstallation(workspaceId: string, installationId: string): Promise<void> {
    await this.http.fetch(`/api/workspaces/${workspaceId}/github/installations/${installationId}`, {
      method: "DELETE",
    });
  }

  async listIssuePullRequests(issueId: string): Promise<{ pull_requests: GitHubPullRequest[] }> {
    return this.http.fetch(`/api/issues/${issueId}/pull-requests`);
  }
}
