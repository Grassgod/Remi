export interface RuntimeProtocolStatus {
  version: number;
  state: "ok" | "upgrade_pending" | "upgrade_failed" | "rejected";
  min_version: string;
  last_error: string | null;
}

export interface RuntimeProtocolLabels {
  version(version: number): string;
  ok: string;
  upgrade_pending: string;
  upgrade_failed(error: string): string;
  rejected: string;
}

const chineseLabels: RuntimeProtocolLabels = {
  version: version => `协议 v${version}`,
  ok: "正常",
  upgrade_pending: "待升级",
  upgrade_failed: error => `升级失败：${error}`,
  rejected: "协议被拒绝",
};

export function formatRuntimeProtocol(status: RuntimeProtocolStatus, labels = chineseLabels): string {
  const detail = status.state === "upgrade_failed"
    ? labels.upgrade_failed(status.last_error ?? "unknown error")
    : labels[status.state];
  return `${labels.version(status.version)} · ${detail}`;
}

/** Count physical daemons, not the provider lanes on each machine. */
export function runtimeProtocolSummary(runtimes: Array<{
  id: string;
  daemonId: string | null;
  runtimeMode: string;
  protocol?: RuntimeProtocolStatus;
}>): { pending: number; failed: number } {
  const states = new Map<string, RuntimeProtocolStatus["state"]>();
  for (const runtime of runtimes) {
    if (runtime.runtimeMode !== "local" || !runtime.protocol) continue;
    const key = runtime.daemonId ?? runtime.id;
    const state = runtime.protocol.state;
    const previous = states.get(key);
    if (!previous || state === "upgrade_failed" || (previous === "ok" && state !== "ok")) states.set(key, state);
  }
  return {
    pending: [...states.values()].filter(state => state === "upgrade_pending" || state === "rejected").length,
    failed: [...states.values()].filter(state => state === "upgrade_failed").length,
  };
}
