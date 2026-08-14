import { HttpClient, type ApiClientOptions } from "./http";
import { AuthEndpoints } from "./endpoints/auth";
import { IssuesEndpoints } from "./endpoints/issues";
import { CommentsEndpoints } from "./endpoints/comments";
import { SubscribersEndpoints } from "./endpoints/subscribers";
import { AgentsEndpoints } from "./endpoints/agents";
import { RuntimesEndpoints } from "./endpoints/runtimes";
import { BillingEndpoints } from "./endpoints/billing";
import { DashboardEndpoints } from "./endpoints/dashboard";
import { TasksEndpoints } from "./endpoints/tasks";
import { InboxEndpoints } from "./endpoints/inbox";
import { NotificationPreferencesEndpoints } from "./endpoints/notification-preferences";
import { ConfigEndpoints } from "./endpoints/config";
import { WorkspacesEndpoints } from "./endpoints/workspaces";
import { MembersEndpoints } from "./endpoints/members";
import { InvitationsEndpoints } from "./endpoints/invitations";
import { SkillsEndpoints } from "./endpoints/skills";
import { TokensEndpoints } from "./endpoints/tokens";
import { AttachmentsEndpoints } from "./endpoints/attachments";
import { ChatEndpoints } from "./endpoints/chat";
import { ProjectsEndpoints } from "./endpoints/projects";
import { ProjectDocsEndpoints } from "./endpoints/project-docs";
import { LabelsEndpoints } from "./endpoints/labels";
import { PinsEndpoints } from "./endpoints/pins";
import { SquadsEndpoints } from "./endpoints/squads";
import { AutopilotsEndpoints } from "./endpoints/autopilots";
import { GitHubEndpoints } from "./endpoints/github";
import { LarkEndpoints } from "./endpoints/lark";
import { RepositoriesEndpoints } from "./endpoints/repositories";
import { IssueSharesEndpoints } from "./endpoints/issue-shares";

export { ApiError, PreviewTooLargeError, PreviewUnsupportedError } from "./http";
export type { ApiClientIdentity, ApiClientOptions } from "./http";
export type { LoginResponse } from "./endpoints/auth";

/** Copies an endpoint module's prototype methods onto the facade, bound to the
 *  module instance. Own properties (the `http` reference) are left behind — the
 *  facade owns its own. */
function bindEndpoints(instance: object): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(instance) as object)) {
    if (key === "constructor") continue;
    const value = (instance as unknown as Record<string, unknown>)[key];
    if (typeof value === "function") bound[key] = value.bind(instance);
  }
  return bound;
}

/** Every endpoint module, in the order their methods are copied onto the
 *  facade. Adding a domain means adding one line here and one `extends` entry
 *  below — nothing else in this file changes. */
export const ENDPOINT_FACTORIES: ReadonlyArray<(http: HttpClient) => object> = [
  (http: HttpClient) => new AuthEndpoints(http),
  (http: HttpClient) => new IssuesEndpoints(http),
  (http: HttpClient) => new CommentsEndpoints(http),
  (http: HttpClient) => new SubscribersEndpoints(http),
  (http: HttpClient) => new AgentsEndpoints(http),
  (http: HttpClient) => new RuntimesEndpoints(http),
  (http: HttpClient) => new BillingEndpoints(http),
  (http: HttpClient) => new DashboardEndpoints(http),
  (http: HttpClient) => new TasksEndpoints(http),
  (http: HttpClient) => new InboxEndpoints(http),
  (http: HttpClient) => new NotificationPreferencesEndpoints(http),
  (http: HttpClient) => new ConfigEndpoints(http),
  (http: HttpClient) => new WorkspacesEndpoints(http),
  (http: HttpClient) => new MembersEndpoints(http),
  (http: HttpClient) => new InvitationsEndpoints(http),
  (http: HttpClient) => new SkillsEndpoints(http),
  (http: HttpClient) => new TokensEndpoints(http),
  (http: HttpClient) => new AttachmentsEndpoints(http),
  (http: HttpClient) => new ChatEndpoints(http),
  (http: HttpClient) => new ProjectsEndpoints(http),
  (http: HttpClient) => new ProjectDocsEndpoints(http),
  (http: HttpClient) => new LabelsEndpoints(http),
  (http: HttpClient) => new PinsEndpoints(http),
  (http: HttpClient) => new SquadsEndpoints(http),
  (http: HttpClient) => new AutopilotsEndpoints(http),
  (http: HttpClient) => new GitHubEndpoints(http),
  (http: HttpClient) => new LarkEndpoints(http),
  (http: HttpClient) => new RepositoriesEndpoints(http),
  (http: HttpClient) => new IssueSharesEndpoints(http),
];

// Declaration merging: the facade's type is the union of every endpoint
// module's public methods, so all ~226 `api.xxx()` call sites keep their exact
// signatures while the implementations live one file per domain.
//
// no-unsafe-declaration-merging guards against the interface promising members
// the class never provides. Here the constructor copies them from
// ENDPOINT_FACTORIES, and client-composition.test.ts asserts that every method
// declared by every module is present and bound on a real instance — the
// runtime check the compiler cannot do.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- wiring asserted in client-composition.test.ts
export interface ApiClient extends
    AuthEndpoints,
    IssuesEndpoints,
    CommentsEndpoints,
    SubscribersEndpoints,
    AgentsEndpoints,
    RuntimesEndpoints,
    BillingEndpoints,
    DashboardEndpoints,
    TasksEndpoints,
    InboxEndpoints,
    NotificationPreferencesEndpoints,
    ConfigEndpoints,
    WorkspacesEndpoints,
    MembersEndpoints,
    InvitationsEndpoints,
    SkillsEndpoints,
    TokensEndpoints,
    AttachmentsEndpoints,
    ChatEndpoints,
    ProjectsEndpoints,
    ProjectDocsEndpoints,
    LabelsEndpoints,
    PinsEndpoints,
    SquadsEndpoints,
    AutopilotsEndpoints,
    GitHubEndpoints,
    LarkEndpoints,
    RepositoriesEndpoints,
    IssueSharesEndpoints {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see the interface above
export class ApiClient {
  constructor(baseUrl: string, options?: ApiClientOptions) {
    const http = new HttpClient(baseUrl, options);
    Object.assign(this, { http }, ...ENDPOINT_FACTORIES.map((create) => bindEndpoints(create(http))));
  }

  getBaseUrl(): string {
    return this.http.getBaseUrl();
  }

  setToken(token: string | null) {
    this.http.setToken(token);
  }
}
