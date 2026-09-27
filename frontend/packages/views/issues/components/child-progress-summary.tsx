import { useT } from "../../i18n";
import type { ChildProgress } from "./list-row";

export function ChildProgressSummary({ progress }: { progress: ChildProgress }) {
  const { t } = useT("issues");
  const parts = [
    { label: t(($) => $.display.progress_active), count: progress.active ?? 0, color: "text-sky-700 dark:text-sky-300" },
    { label: t(($) => $.display.progress_waiting), count: progress.waiting ?? 0, color: progress.waiting ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground" },
    { label: t(($) => $.display.progress_blocked), count: progress.blocked ?? 0, color: progress.blocked ? "text-red-700 dark:text-red-300" : "text-muted-foreground" },
    { label: t(($) => $.display.progress_done), count: progress.done + (progress.cancelled ?? 0), color: "text-emerald-700 dark:text-emerald-300" },
  ];
  return (
    <span
      className="inline-flex max-w-full shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded bg-muted/60 px-1.5 py-0.5 text-[11px] tabular-nums"
      title={parts.map(({ label, count }) => `${label} ${count}`).join(" · ")}
      aria-label={parts.map(({ label, count }) => `${label} ${count}`).join(" · ")}
    >
      {parts.map(({ label, count, color }, index) => (
        <span key={label} className="inline-flex items-center gap-1">
          {index > 0 && <span className="text-muted-foreground/50">·</span>}
          <span className={color}><span className="hidden lg:inline">{label} </span>{count}</span>
        </span>
      ))}
    </span>
  );
}
