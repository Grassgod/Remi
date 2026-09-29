import type { AgentRuntime } from "@multiremi/core/types";
import { formatRuntimeProtocol } from "@multiremi/core/runtimes";
import { useT } from "../../i18n";

export function RuntimeProtocolLine({ runtime }: { runtime: AgentRuntime }) {
  const { t } = useT("runtimes");
  if (!runtime.protocol || runtime.runtime_mode !== "local") return null;
  const text = formatRuntimeProtocol(runtime.protocol, {
    version: version => t($ => $.protocol.version, { version }),
    ok: t($ => $.protocol.ok),
    upgrade_pending: t($ => $.protocol.upgrade_pending),
    upgrade_failed: error => t($ => $.protocol.upgrade_failed, { error }),
    rejected: t($ => $.protocol.rejected),
  });
  return <p className="min-w-0 truncate text-xs text-muted-foreground" title={text}>{text}</p>;
}
