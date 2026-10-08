import type { UsageReport } from "@multiremi/contracts/usage-accounting";
import { useT } from "../i18n";

export function ModelLabel({
  model,
}: {
  model: Pick<
    UsageReport["by_model"][number],
    | "provider"
    | "model"
    | "requested_model"
    | "model_provenance"
    | "cost_allocation_complete"
    | "purpose"
    | "connection_id"
  >;
}) {
  const { t } = useT("usage");
  const title =
    model.model_provenance === "unallocated_cost"
      ? t(($) => $.price.unallocated_cost)
      : (model.model ??
        model.requested_model ??
        t(($) => $.price.unknown_model));
  const source =
    model.model_provenance === "provider_reported"
      ? t(($) => $.price.reported_model)
      : model.model_provenance === "session_acknowledged"
        ? t(($) => $.price.session_model)
        : model.model_provenance === "configured"
          ? t(($) => $.price.configured_model)
          : model.model !== null
            ? t(($) => $.common.unknown)
            : null;
  return (
    <div className="min-w-0">
      <span
        className="block truncate font-mono text-xs"
        title={`${model.provider} · ${title}`}
      >
        {model.provider} · {title}
      </span>
      {model.model === null && model.requested_model && (
        <span className="block text-[11px] text-muted-foreground">
          {t(($) => $.experience.requested_only)}
        </span>
      )}
      <details className="mt-1 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">
          {t(($) => $.experience.model_detail)}
        </summary>
        {source && <p title={model.model_provenance}>{source}</p>}
        {model.requested_model && model.requested_model !== model.model && (
          <p className="break-all">
            {t(($) => $.price.requested)}: {model.requested_model}
          </p>
        )}
        {model.cost_allocation_complete === false && (
          <p>{t(($) => $.price.allocation_unknown)}</p>
        )}
        {model.purpose === "progress_summary" && (
          <p>{t(($) => $.price.progress_summary)}</p>
        )}
        {model.connection_id && (
          <code className="block break-all">{model.connection_id}</code>
        )}
      </details>
    </div>
  );
}
