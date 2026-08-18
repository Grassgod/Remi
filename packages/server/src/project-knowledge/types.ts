import type {
  MultiremiProjectDoc,
  MultiremiProjectDocKind,
  MultiremiProjectDocRevision,
  MultiremiWorkspaceProjectDoc,
} from "@multiremi/contracts/types.js";

export type ProjectKnowledgeMode = "sql" | "shadow" | "openviking";
export type ProjectKnowledgeSyncStatus = "sql" | "pending" | "ready" | "failed" | "deleting";

export interface ProjectKnowledgeControl {
  storageBackend: "sql" | "openviking";
  contentUri: string | null;
  contentSha256: string | null;
  syncStatus: ProjectKnowledgeSyncStatus;
  syncError: string | null;
  snapshotOid: string | null;
}

export type ProjectKnowledgeDoc = Omit<MultiremiProjectDoc, keyof ProjectKnowledgeControl> & ProjectKnowledgeControl;

export interface ProjectKnowledgeRevision extends MultiremiProjectDocRevision {
  contentUri: string | null;
  contentSha256: string | null;
  snapshotOid: string | null;
}

export type ProjectKnowledgeWorkspaceDoc = Omit<MultiremiWorkspaceProjectDoc, keyof ProjectKnowledgeControl> & ProjectKnowledgeControl;

export interface ProjectKnowledgeSearchHit {
  doc: ProjectKnowledgeDoc;
  score: number | null;
  snippet: string | null;
  uri: string;
}

export interface ProjectKnowledgeSearchOptions {
  kind?: MultiremiProjectDocKind | string | null;
  limit?: number;
}

export interface ProjectKnowledgeWriteControl {
  contentUri: string;
  contentSha256: string;
  snapshotOid: string | null;
  syncStatus?: "pending" | "ready" | "failed" | "deleting";
  syncError?: string | null;
}

export interface ProjectKnowledgeMigrationStatus {
  mode: ProjectKnowledgeMode;
  workspaceId: string;
  openviking: "ready" | "unavailable" | "not_configured";
  total: number;
  sql: number;
  pending: number;
  ready: number;
  failed: number;
  deleting: number;
}

export interface ProjectKnowledgeMigrationResult {
  dryRun: boolean;
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
  failures: Array<{ docId: string; error: string }>;
}

export interface OpenVikingFindHit {
  uri: string;
  score: number | null;
  abstract: string | null;
  tags: string[];
}

export interface OpenVikingSnapshotCommit {
  oid: string | null;
  message: string;
  createdAt: string | null;
}

export interface OpenVikingClientContract {
  health(): Promise<void>;
  ensureDirectory(uri: string): Promise<void>;
  read(uri: string): Promise<string>;
  exists(uri: string): Promise<boolean>;
  create(uri: string, rootUri: string, content: string): Promise<void>;
  replace(uri: string, rootUri: string, content: string, baseHash: string): Promise<void>;
  remove(uri: string): Promise<void>;
  setTags(uri: string, tags: string[]): Promise<void>;
  find(query: string, targetUri: string | string[], limit: number, tags?: string[]): Promise<OpenVikingFindHit[]>;
  commit(message: string, paths: string[]): Promise<string | null>;
  log(paths: string[], limit?: number): Promise<OpenVikingSnapshotCommit[]>;
  show(targetRef: string, path: string): Promise<string>;
}
