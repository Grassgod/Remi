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

export const getDailyDates = () => request<import("./types").DailyLogEntry[]>("/api/v1/memory/daily");
export const getDaily = (date: string) =>
  request<import("./types").DailyEntry>(`/api/v1/memory/daily/${date}`);

// Sessions
export const getSessions = () => request<import("./types").SessionEntry[]>("/api/v1/sessions");
export const clearSession = (key: string) =>
  request(`/api/v1/sessions/${encodeURIComponent(key)}`, { method: "DELETE" });
export const clearAllSessions = () =>
  request("/api/v1/sessions", { method: "DELETE" });

// Auth
export const getTokenStatus = () => request<import("./types").TokenStatus[]>("/api/v1/auth/status");

// Config
export const getConfig = () => request<import("./types").RemiConfig>("/api/v1/config");
export const updateConfig = (patch: Record<string, unknown>) =>
  request("/api/v1/config", { method: "PUT", body: JSON.stringify(patch) });

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
export const scanCliUsage = () =>
  request<{ count: number }>("/api/v1/analytics/scan-cli", { method: "POST" });

// Traces
export const getTraces = (date?: string, limit = 50) =>
  request<import("./types").TraceData[]>(`/api/v1/traces?${date ? `date=${date}&` : ""}limit=${limit}`);
export const getTrace = (traceId: string) =>
  request<import("./types").TraceData>(`/api/v1/traces/${traceId}`);

// Logs
export const getLogs = (params: { date?: string; level?: string; module?: string; traceId?: string; limit?: number; offset?: number }) => {
  const qs = new URLSearchParams();
  if (params.date) qs.set("date", params.date);
  if (params.level) qs.set("level", params.level);
  if (params.module) qs.set("module", params.module);
  if (params.traceId) qs.set("traceId", params.traceId);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  return request<import("./types").LogQueryResult>(`/api/v1/logs?${qs.toString()}`);
};
export const getLogModules = (date?: string) =>
  request<string[]>(`/api/v1/logs/modules${date ? `?date=${date}` : ""}`);

// Monitor
export const getMonitorStats = () => request<import("./types").MonitorStats>("/api/v1/monitor/stats");
