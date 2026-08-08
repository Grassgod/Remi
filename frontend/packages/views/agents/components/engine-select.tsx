"use client";

import { useId } from "react";
import { useFleetProviderModels } from "@multiremi/core/runtimes";
import { Label } from "@multiremi/ui/components/ui/label";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { useT } from "../../i18n";

// The engines a pool agent can run on. Static by design: these are the
// providers the daemon fleet ships bridges for; the fleet catalog only
// refines each engine's models + capacity. Single declaration — the create
// dialog, the edit dialog, the inspector picker and the list filter all
// import it from here.
export const ENGINES = ["claude", "codex"] as const;

/**
 * The engine (provider) choice as a segmented button pair, plus the
 * "no online capacity" warning that belongs with it.
 *
 * This is the only "where does it run"-adjacent choice left in the agent
 * forms — machines are gone from the flow, the pool schedules work onto any
 * online runtime of the chosen engine. The create and edit dialogs rendered
 * identical copies of this markup; the inspector's `EnginePicker` is the same
 * choice in a popover chip for dense surfaces and stays separate.
 *
 * `onChange` only fires for a real change, so callers can put their
 * engine-switch resets (model, thinking level) straight in the handler.
 */
export function EngineSelect({
  wsId,
  value,
  onChange,
}: {
  wsId: string;
  value: string;
  onChange: (engine: string) => void;
}) {
  const { t } = useT("agents");
  const labelId = useId();
  // Capacity signal for the selected engine — 0 online machines means new
  // tasks would queue until one comes up. Purely informational; saving
  // stays allowed.
  const fleet = useFleetProviderModels(wsId, value);

  return (
    <div>
      <Label id={labelId} className="text-xs text-muted-foreground">
        {t(($) => $.create_dialog.engine_label)}
      </Label>
      <div
        role="group"
        aria-labelledby={labelId}
        className="mt-1.5 flex gap-2"
      >
        {ENGINES.map((engine) => (
          <button
            key={engine}
            type="button"
            onClick={() => {
              if (engine !== value) onChange(engine);
            }}
            className={`flex flex-1 items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
              value === engine
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted"
            }`}
          >
            <ProviderLogo provider={engine} className="h-4 w-4 shrink-0" />
            <span className="font-medium capitalize">{engine}</span>
          </button>
        ))}
      </div>
      {!fleet.isLoading && fleet.onlineRuntimeCount === 0 && (
        <p className="mt-1.5 text-xs text-warning">
          {t(($) => $.create_dialog.engine_no_capacity)}
        </p>
      )}
    </div>
  );
}
