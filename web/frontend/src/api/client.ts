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
