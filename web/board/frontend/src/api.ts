/**
 * Board API client — typed fetch wrapper.
 */

const BASE = "";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ── Types ──

export interface Project {
  slug: string;
  name: string;
  cwd: string;
  repoUrl: string | null;
  repoType: string | null;
  chatId: string | null;
}

export interface Mission {
  id: string;
  title: string;
  description: string | null;
  status: string;
  projectId: string;
  chatId: string;
  threadId: string | null;
  currentStep: string;
  contract: unknown;
  mrUrl: string | null;
  mrStatus: string | null;
  outputDir: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  totalTokens: number;
  totalCost: number;
  totalDuration: number;
}

export interface ProjectStats {
  total: number;
  byStatus: Record<string, number>;
  totalCost: number;
  totalTokens: number;
}

// ── API calls ──

export const fetchProjects = () => request<Project[]>("/api/projects");

export const fetchMissions = (slug: string) =>
  request<Mission[]>(`/api/projects/${slug}/missions`);

export const fetchStats = (slug: string) =>
  request<ProjectStats>(`/api/projects/${slug}/stats`);

export const fetchMission = (id: string) =>
  request<Mission>(`/api/missions/${id}`);

export const createMission = (data: { title: string; projectId: string; chatId: string; description?: string }) =>
  request<Mission>("/api/missions", { method: "POST", body: JSON.stringify(data) });

export const updateMission = (id: string, data: Partial<Pick<Mission, "status" | "title" | "description">>) =>
  request<{ ok: boolean }>(`/api/missions/${id}`, { method: "PATCH", body: JSON.stringify(data) });

export const deleteMission = (id: string) =>
  request<{ ok: boolean }>(`/api/missions/${id}`, { method: "DELETE" });

// ── Messages ──

export interface StepItem {
  type: "thinking" | "tool";
  content: string;
  name?: string;
  thinking?: string;  // merged thinking before tool (if type=tool)
}

export interface ChatMessage {
  id: string;
  type: string;       // text | assistant
  content: string;
  senderType: string;  // user | app
  senderId: string;
  createTime: string;  // unix ms or ISO string
  steps?: StepItem[];  // interleaved thinking + tool_use
  sessionName?: string; // e.g. "内卷的 Remi·Papilio"
  meta?: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    duration: number;
    toolCount?: number;
    sessionId?: string;
  };
}

export const fetchMessages = (missionId: string) =>
  request<ChatMessage[]>(`/api/missions/${missionId}/messages`);
