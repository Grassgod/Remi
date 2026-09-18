import type { RuntimeModelThinking } from "@multiremi/core/types";
import { useT } from "../../../i18n";

/** Keep absence, authoritative empty sets and failed loads distinct. */
export function ThinkingStatus({ thinking, isLoading, isError, modelUnavailable, modelExecutionUnknown }: {
  thinking?: RuntimeModelThinking;
  isLoading?: boolean;
  isError?: boolean;
  modelUnavailable?: boolean;
  modelExecutionUnknown?: boolean;
}) {
  const { t } = useT("agents");
  if (modelExecutionUnknown) {
    return <span className="px-1.5 py-0.5 text-xs text-muted-foreground" role="status">
      {t(($) => $.pickers.model_execution_unknown)}
    </span>;
  }
  if (modelUnavailable) {
    return <span className="px-1.5 py-0.5 text-xs text-destructive" role="status">
      {t(($) => $.pickers.model_unavailable)}
    </span>;
  }
  const status = isError ? "error" : thinking?.status
    ?? (thinking ? (thinking.supported_levels.length ? "supported" : "unsupported") : "unknown");
  if (!isLoading && status === "supported") {
    const level = thinking?.supported_levels.find((entry) => entry.value === thinking.default_level);
    return level ? <span className="text-xs text-muted-foreground">
      {t(($) => $.pickers.thinking_model_default, { value: level.label })}
    </span> : null;
  }
  return <span className="px-1.5 py-0.5 text-xs text-muted-foreground" role="status">
    {isLoading ? t(($) => $.pickers.thinking_loading)
      : status === "error" ? t(($) => $.pickers.thinking_load_error)
      : status === "unsupported" ? t(($) => $.pickers.thinking_unsupported)
      : t(($) => $.pickers.thinking_unknown)}
  </span>;
}
