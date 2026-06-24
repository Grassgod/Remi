/**
 * Compact KPI tile used at the top of config pages. Shares the same visual
 * language as the public HomePage stats.
 */
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

export type StatAccent = "blue" | "violet" | "emerald" | "amber" | "rose" | "indigo";

const ACCENTS: Record<StatAccent, { bar: string; text: string; ring: string }> = {
  blue: { bar: "from-blue-500 to-cyan-400", text: "text-blue-500", ring: "ring-blue-500/20" },
  violet: { bar: "from-violet-500 to-purple-400", text: "text-violet-500", ring: "ring-violet-500/20" },
  emerald: { bar: "from-emerald-500 to-teal-400", text: "text-emerald-500", ring: "ring-emerald-500/20" },
  amber: { bar: "from-amber-500 to-orange-400", text: "text-amber-500", ring: "ring-amber-500/20" },
  rose: { bar: "from-rose-500 to-pink-400", text: "text-rose-500", ring: "ring-rose-500/20" },
  indigo: { bar: "from-indigo-500 to-sky-400", text: "text-indigo-500", ring: "ring-indigo-500/20" },
};

function useCountUp(target: number, durationMs = 600): number {
  const [value, setValue] = useState(target);
  const last = useRef(target);
  useEffect(() => {
    let raf = 0;
    const from = last.current;
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const v = Math.round(from + (target - from) * (1 - Math.pow(1 - p, 3)));
      setValue(v);
      if (p < 1) raf = requestAnimationFrame(step);
      else last.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

export interface StatTileProps {
  label: string;
  value: number | string;
  hint?: string;
  icon: LucideIcon;
  accent?: StatAccent;
  delayMs?: number;
}

export function StatTile({ label, value, hint, icon: Icon, accent = "blue", delayMs = 0 }: StatTileProps) {
  const styles = ACCENTS[accent];
  const animated = typeof value === "number" ? useCountUp(value) : null;

  return (
    <div
      className="group relative overflow-hidden rounded-xl border border-border/60 bg-card/90 p-3.5 shadow-sm backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
      style={{ animation: `fade-in 0.4s ease-out ${delayMs}ms both` }}
    >
      <div className={`absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r ${styles.bar} opacity-70`} />
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        <div className={`flex h-6 w-6 items-center justify-center rounded-md bg-background/60 ring-1 ${styles.ring}`}>
          <Icon className={`h-3 w-3 ${styles.text}`} />
        </div>
      </div>
      <div className="mt-1.5 text-[24px] font-semibold leading-none tabular-nums text-foreground">
        {animated ?? value}
      </div>
      {hint && <div className="mt-1 text-[10px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}
