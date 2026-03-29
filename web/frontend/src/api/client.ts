const BASE = import.meta.env.DEV ? "" : "";

let authToken = "";

export function setAuthToken(token: string) {
  authToken = token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  if (init?.body && typeof init.body === "string") {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  return res.json();
}

// Status
export const getStatus = () => request<import("./types").SystemStatus>("/api/v1/status");

// Memory
export const getGlobalMemory = () => request<{ content: string }>("/api/v1/memory/global");
export const putGlobalMemory = (content: string) =>
  request("/api/v1/memory/global", { method: "PUT", body: JSON.stringify({ content }) });

export const getEntities = () => request<import("./types").EntitySummary[]>("/api/v1/memory/entities");
export const getEntity = (type: string, name: string) =>
  request<import("./types").EntityDetail>(`/api/v1/memory/entities/${type}/${encodeURIComponent(name)}`);
export const createEntity = (data: { type: string; name: string; content?: string }) =>
  request("/api/v1/memory/entities", { method: "POST", body: JSON.stringify(data) });
export const updateEntity = (type: string, name: string, content: string) =>
  request(`/api/v1/memory/entities/${type}/${encodeURIComponent(name)}`, {
    method: "PUT", body: JSON.stringify({ content }),
  });
export const deleteEntity = (type: string, name: string) =>
  request(`/api/v1/memory/entities/${type}/${encodeURIComponent(name)}`, { method: "DELETE" });

export const searchMemory = (q: string) =>
  request<import("./types").SearchResult[]>(`/api/v1/memory/search?q=${encodeURIComponent(q)}`);

export const recallDebug = (query: string, cwd?: string) =>
  request<import("./types").RecallDebugResult>("/api/v1/memory/recall", {
    method: "POST", body: JSON.stringify({ query, cwd }),
  });

export const getProjectMemories = () =>
  request<import("./types").ProjectMemory[]>("/api/v1/memory/projects");
export const getProjectMemoryFile = (projectId: string, path: string) =>
  request<{ content: string }>(`/api/v1/memory/projects/${projectId}/${path}`);

export const getDailyDates = () => request<import("./types").DailyLogEntry[]>("/api/v1/memory/daily");
export const getDaily = (date: string) =>
  request<import("./types").DailyEntry>(`/api/v1/memory/daily/${date}`);

// Auth
export const getTokenStatus = () => request<import("./types").TokenStatus[]>("/api/v1/auth/status");

// Config
export const getConfig = () => request<import("./types").RemiConfig>("/api/v1/config");
export const updateConfig = (patch: Record<string, unknown>) =>
  request("/api/v1/config", { method: "PUT", body: JSON.stringify(patch) });

// Bot Menu
export const getBotMenu = () => request<any>("/api/v1/bot-menu");
export const updateBotMenu = (menu: any) =>
  request("/api/v1/bot-menu", { method: "PUT", body: JSON.stringify(menu) });
export const syncBotMenu = () =>
  request<{ ok: boolean }>("/api/v1/bot-menu/sync", { method: "POST" });

// Projects
export const getProjects = () => request<import("./types").ProjectMap>("/api/v1/projects");
export const createProject = (alias: string, path: string) =>
  request("/api/v1/projects", { method: "POST", body: JSON.stringify({ alias, path }) });
export const updateProject = (alias: string, path: string) =>
  request(`/api/v1/projects/${encodeURIComponent(alias)}`, { method: "PUT", body: JSON.stringify({ path }) });
export const deleteProject = (alias: string) =>
  request(`/api/v1/projects/${encodeURIComponent(alias)}`, { method: "DELETE" });

// Scheduler
export const getSchedulerStatus = () => request<import("./types").SchedulerStatus>("/api/v1/scheduler/status");
export const getSchedulerHistory = (jobId?: string, limit = 50) => {
  const params = new URLSearchParams();
  if (jobId) params.set("jobId", jobId);
  params.set("limit", String(limit));
  return request<import("./types").CronRunEntry[]>(`/api/v1/scheduler/history?${params}`);
};
export const getSchedulerSummary = (days = 7) =>
  request<import("./types").DailySchedulerSummary[]>(`/api/v1/scheduler/summary?days=${days}`);

// Analytics
export const getAnalyticsSummary = () => request<import("./types").AnalyticsSummary>("/api/v1/analytics/summary");
export const getAnalyticsDaily = (start: string, end: string) =>
  request<import("./types").DailySummary[]>(`/api/v1/analytics/daily?start=${start}&end=${end}`);
export const getRecentMetrics = (limit = 50) =>
  request<import("./types").TokenMetricEntry[]>(`/api/v1/analytics/recent?limit=${limit}`);
// Traces
export const getTraceStats = (date?: string) =>
  request<import("./types").TraceStats>(`/api/v1/traces/stats${date ? `?date=${date}` : ""}`);
export const getTraces = (opts: { date?: string; limit?: number; offset?: number; status?: string; search?: string }) => {
  const params = new URLSearchParams();
  if (opts.date) params.set("date", opts.date);
  params.set("limit", String(opts.limit ?? 50));
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.status) params.set("status", opts.status);
  if (opts.search) params.set("search", opts.search);
  return request<import("./types").TraceListResponse>(`/api/v1/traces?${params}`);
};
export const getTraceDetail = (id: number) =>
  request<import("./types").TraceDetail>(`/api/v1/traces/${id}/detail`);

// Logs
export const getLogs = (params: { date?: string; level?: string; module?: string; traceId?: string; search?: string; limit?: number; offset?: number }) => {
  const qs = new URLSearchParams();
  if (params.date) qs.set("date", params.date);
  if (params.level) qs.set("level", params.level);
  if (params.module) qs.set("module", params.module);
  if (params.traceId) qs.set("traceId", params.traceId);
  if (params.search) qs.set("search", params.search);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  return request<import("./types").LogQueryResult>(`/api/v1/logs?${qs.toString()}`);
};
export const getLogStats = (params?: { date?: string; level?: string; module?: string; search?: string; traceId?: string }) => {
  const qs = new URLSearchParams();
  if (params?.date) qs.set("date", params.date);
  if (params?.level) qs.set("level", params.level);
  if (params?.module) qs.set("module", params.module);
  if (params?.search) qs.set("search", params.search);
  if (params?.traceId) qs.set("traceId", params.traceId);
  const q = qs.toString();
  return request<import("./types").LogStats>(`/api/v1/logs/stats${q ? `?${q}` : ""}`);
};
export const getLogModules = (date?: string) =>
  request<string[]>(`/api/v1/logs/modules${date ? `?date=${date}` : ""}`);

// Monitor
export const getMonitorStats = () => request<import("./types").MonitorStats>("/api/v1/monitor/stats");

// Symlinks
export const getSymlinksStatus = () => request<import("./types").SymlinksStatus>("/api/v1/symlinks/status");
export const fixAllSymlinks = () =>
  request<{ fixed: number; errors: string[] }>("/api/v1/symlinks/fix-all", { method: "POST" });
export const ensureSymlink = (cwd: string) =>
  request<{ ok: boolean }>(`/api/v1/symlinks/ensure/${encodeURIComponent(cwd)}`, { method: "POST" });

// Database
export const getDbStats = () => request<import("./types").DbStats>("/api/v1/db/stats");
export const getDbKv = () => request<import("./types").KvEntry[]>("/api/v1/db/kv");
export const getDbEmbeddings = () => request<import("./types").EmbeddingEntry[]>("/api/v1/db/embeddings");

// Conversations
export const getConversations = (limit = 50, offset = 0, chatId?: string) => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (chatId) params.set("chatId", chatId);
  return request<import("./types").ConversationSummary[]>(`/api/v1/conversations?${params}`);
};
export const getConversationMessages = (chatId: string, threadId?: string, sessionId?: string) => {
  const qp = new URLSearchParams();
  if (threadId) qp.set("threadId", threadId);
  if (sessionId) qp.set("sessionId", sessionId);
  const params = qp.toString() ? `?${qp}` : "";
  return request<import("./types").ChatMessage[]>(`/api/v1/conversations/${encodeURIComponent(chatId)}/messages${params}`);
};
export const getChats = () =>
  request<import("./types").ChatInfo[]>("/api/v1/chats");

// Missions
export const getMissions = (projectId?: string, status?: string) => {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (status) params.set("status", status);
  const qs = params.toString();
  return request<import("./types").MissionItem[]>(`/api/v1/missions${qs ? `?${qs}` : ""}`);
};
export const getMission = (id: string) =>
  request<import("./types").MissionItem>(`/api/v1/missions/${id}`);
export const getMissionDetail = (id: string) =>
  request<import("./types").MissionDetailItem>(`/api/v1/missions/${id}`);
export const updateMission = (id: string, patch: { status?: string; title?: string; description?: string }) =>
  request<{ ok: boolean }>(`/api/v1/missions/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const getMissionStats = (projectId: string) =>
  request<import("./types").MissionStats>(`/api/v1/missions/stats?projectId=${encodeURIComponent(projectId)}`);

// Wiki
export const getWikiTree = () =>
  request<import("./types").WikiFileNode[]>("/api/v1/wiki/tree");
export const getWikiFile = (path: string) =>
  request<import("./types").WikiFileContent>(`/api/v1/wiki/file?path=${encodeURIComponent(path)}`);
export const getWikiHistory = (path: string, limit = 20) =>
  request<import("./types").WikiGitEntry[]>(`/api/v1/wiki/history?path=${encodeURIComponent(path)}&limit=${limit}`);
export const getWikiDiff = (path: string, commit: string) =>
  request<{ diff: string }>(`/api/v1/wiki/diff?path=${encodeURIComponent(path)}&commit=${commit}`);
export const putWikiFile = (path: string, content: string) =>
  request(`/api/v1/wiki/file?path=${encodeURIComponent(path)}`, {
    method: "PUT", body: JSON.stringify({ content }),
  });

// Filesystem browse
export const browseDirs = (path?: string) =>
  request<{ path: string; dirs: { name: string; path: string }[] }>(`/api/v1/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);

// Skills
export const getSkills = () =>
  request<import("./types").SkillInfo[]>("/api/v1/skills");
export const getSkillFile = (name: string, path = "SKILL.md") =>
  request<{ content: string }>(`/api/v1/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`);
export const putSkillFile = (name: string, content: string, path = "SKILL.md") =>
  request(`/api/v1/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`, {
    method: "PUT", body: JSON.stringify({ content }),
  });
export const getSkillReports = (name: string) =>
  request<string[]>(`/api/v1/skills/${encodeURIComponent(name)}/reports`);
export const getSkillReport = (name: string, date: string) =>
  request<{ content: string }>(`/api/v1/skills/${encodeURIComponent(name)}/reports/${date}`);
export const getSkillsBasePath = () =>
  request<{ basePath: string }>("/api/v1/skills/base-path");
export const getSkillTree = (name: string) =>
  request<import("./types").SkillFileNode[]>(`/api/v1/skills/${encodeURIComponent(name)}/tree`);

// Agents
export const getAgents = () =>
  request<import("./types").AgentInfo[]>("/api/v1/agents");
export const getAgentDetail = (name: string) =>
  request<import("./types").AgentDetail>(`/api/v1/agents/${encodeURIComponent(name)}`);
export const getAgentRuns = (name: string, limit = 50) =>
  request<import("./types").AgentRunEntry[]>(`/api/v1/agents/${encodeURIComponent(name)}/runs?limit=${limit}`);
export const updateAgentClaudeMd = (name: string, content: string) =>
  request(`/api/v1/agents/${encodeURIComponent(name)}/claude-md`, {
    method: "PUT", body: JSON.stringify({ content }),
  });
export const updateAgentSettings = (name: string, content: string) =>
  request(`/api/v1/agents/${encodeURIComponent(name)}/settings`, {
    method: "PUT", body: JSON.stringify({ content }),
  });
export const updateAgentSkill = (name: string, skillName: string, content: string) =>
  request(`/api/v1/agents/${encodeURIComponent(name)}/skills/${encodeURIComponent(skillName)}`, {
    method: "PUT", body: JSON.stringify({ content }),
  });
export const getAgentSkillTree = (agentName: string, skillName: string) =>
  request<import("./types").SkillFileNode[]>(`/api/v1/agents/${encodeURIComponent(agentName)}/skills/${encodeURIComponent(skillName)}/tree`);
export const getAgentSkillFile = (agentName: string, skillName: string, path = "SKILL.md") =>
  request<{ content: string }>(`/api/v1/agents/${encodeURIComponent(agentName)}/skills/${encodeURIComponent(skillName)}/file?path=${encodeURIComponent(path)}`);
// MCP
export const getMcpScopes = () =>
  request<import("./types").McpScope[]>("/api/v1/mcp/scopes");

export const getMcpScopeDetail = (id: string) =>
  request<import("./types").McpScopeDetail>(`/api/v1/mcp/scopes/${encodeURIComponent(id)}`);

export const writeMcpScope = (id: string, content: string) =>
  request<{ ok: boolean }>(`/api/v1/mcp/scopes/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });

export const deleteMcpServer = (scopeId: string, serverName: string) =>
  request<{ ok: boolean }>(`/api/v1/mcp/scopes/${encodeURIComponent(scopeId)}/servers/${encodeURIComponent(serverName)}`, {
    method: "DELETE",
  });

export const mergeMcpServers = (scopeId: string, content: string) =>
  request<{ ok: boolean; added: string[] }>(`/api/v1/mcp/scopes/${encodeURIComponent(scopeId)}/merge`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
