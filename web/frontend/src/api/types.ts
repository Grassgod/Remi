// Status
export interface SystemStatus {
  daemon: { alive: boolean; pid: number | null };
  sessions: { total: number; main: number; threads: number };
  tokens: { total: number; valid: number; nextExpiry: string | null };
  memory: { entities: number; entityTypes: string[]; dailyLogs: number; latestLog: string | null };
}

// Memory
export interface EntitySummary {
  type: string;
  name: string;
  tags: string[];
  summary: string;
  aliases: string[];
  related: string[];
  path: string;
  updatedAt: string;
}

export interface EntityDetail extends EntitySummary {
  content: string;
  body: string;
  createdAt: string;
}

export interface DailyLogEntry {
  date: string;
  size: number;
}

export interface DailyEntry {
  date: string;
  content: string;
}

export interface SearchResult {
  source: string;
  name: string;
  snippet: string;
  path: string;
}

// Sessions
export interface SessionEntry {
  key: string;
  sessionId: string;
  isThread: boolean;
}

// Auth
export interface TokenStatus {
  service: string;
  type: string;
  valid: boolean;
  expiresAt: number;
  expiresIn: string;
  refreshable: boolean;
}

// Config
export interface RemiConfig {
  [key: string]: unknown;
}

// Projects
export type ProjectMap = Record<string, string>; // alias → path
