import { ChevronDown, Cpu } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@multiremi/ui/components/ui/dropdown-menu";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { useT } from "../../i18n";

// ---------------------------------------------------------------------------
// Engine filter — dropdown next to the search input. Replaces the old
// per-machine filter: agents are pool workers now, so the only placement
// dimension they carry is the engine (provider) they run on.
// ---------------------------------------------------------------------------

const ENGINES = ["claude", "codex"] as const;

export function EngineFilterDropdown({
  value,
  onChange,
  agentCountByEngine,
  totalAgentCount,
}: {
  value: string | null;
  onChange: (engine: string | null) => void;
  agentCountByEngine: Map<string, number>;
  totalAgentCount: number;
}) {
  const { t } = useT("agents");
  const triggerLabel = value ?? t(($) => $.engine_filter.all);
  const triggerCount = value
    ? (agentCountByEngine.get(value) ?? 0)
    : totalAgentCount;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs"
            data-testid="agents-engine-filter"
          />
        }
      >
        <Cpu className="h-3 w-3 text-muted-foreground" />
        <span className="max-w-[12rem] truncate capitalize">{triggerLabel}</span>
        <span className="font-mono tabular-nums text-muted-foreground/70">
          {triggerCount}
        </span>
        <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 p-0">
        <div className="py-1">
          <EngineFilterItem
            active={value === null}
            onClick={() => onChange(null)}
            count={totalAgentCount}
          >
            {t(($) => $.engine_filter.all)}
          </EngineFilterItem>
          {ENGINES.map((engine) => (
            <EngineFilterItem
              key={engine}
              active={value === engine}
              onClick={() => onChange(engine)}
              count={agentCountByEngine.get(engine) ?? 0}
            >
              <span className="flex items-center gap-1.5">
                <ProviderLogo provider={engine} className="h-3.5 w-3.5 shrink-0" />
                <span className="capitalize">{engine}</span>
              </span>
            </EngineFilterItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EngineFilterItem({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  const { t } = useT("agents");
  return (
    <DropdownMenuItem
      onClick={onClick}
      data-active={active || undefined}
      data-testid={active ? "agents-engine-filter-active" : undefined}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-muted/60 data-highlighted:bg-muted/60"
      }`}
    >
      <span className="min-w-0 flex-1 truncate font-medium">{children}</span>
      <span className="font-mono tabular-nums text-muted-foreground/70">
        {t(($) => $.engine_filter.agent_count, { count })}
      </span>
    </DropdownMenuItem>
  );
}
