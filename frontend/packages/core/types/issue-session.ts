import type { AgentTask } from "./agent";

export type IssueSessionStatus = "active" | "archived";
export type SessionParticipantType = "agent" | "member";

export interface SessionParticipant {
  id: string;
  session_id: string;
  participant_type: SessionParticipantType;
  participant_id: string;
  role: string;
  status: string;
  joined_at: string;
  updated_at: string;
}

export interface IssueSession {
  id: string;
  issue_id: string;
  workspace_id: string;
  title: string;
  status: IssueSessionStatus;
  is_default: boolean;
  holds_workspace?: boolean;
  summary: string | null;
  created_by_type: string;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  participants: SessionParticipant[];
}

export interface SessionEvent {
  id: string;
  session_id: string;
  seq: number;
  author_type: string;
  author_id: string | null;
  kind: string;
  body: string;
  task_id: string | null;
  source_comment_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SessionResult {
  id: string;
  issue_id: string;
  source_session_id: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  published_by_type: string;
  published_by_id: string | null;
  created_at: string;
}

export interface CreateIssueSessionRequest {
  title: string;
  holds_workspace?: boolean;
}

export interface CreateSessionTaskRequest {
  agent_id: string;
  prompt: string;
  priority?: number;
}

export interface IssueSessionTask extends AgentTask {
  issue_session_id: string;
}
