import { Card, CardContent } from "./ui/card";
import { cn } from "@/lib/utils";

interface HourlyChartProps {
  data: Array<{ hour: number; count: number; errors: number }>;
  currentHour?: number;
}

const LABEL_HOURS = [0, 6, 12, 18, 23];

export function HourlyChart({ data, currentHour }: HourlyChartProps) {
  const maxCount = Math.max(...data.map(d => d.count), 1);

  return (
    <Card className="mb-4">
      <CardContent className="px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Hourly Distribution
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            00:00 — 23:00
          </span>
        </div>

        {/* Bars */}
        <div className="flex items-end gap-[2px]" style={{ height: 48 }}>
          {data.map((d) => {
            const heightPct = (d.count / maxCount) * 100;
            const errorPct = d.count > 0 ? (d.errors / d.count) * 100 : 0;
            const isFuture = currentHour !== undefined && d.hour > currentHour;

            return (
              <div
                key={d.hour}
                className="group relative flex-1"
                style={{ height: "100%" }}
                title={`${String(d.hour).padStart(2, "0")}:00 — ${d.count} entries${d.errors > 0 ? `, ${d.errors} errors` : ""}`}
              >
                <div className="absolute bottom-0 left-0 right-0 overflow-hidden rounded-t-[2px]"
                  style={{ height: `${heightPct}%` }}
                >
                  <div
                    className={cn(
                      "absolute bottom-0 left-0 right-0",
                      isFuture ? "bg-muted/30" : "bg-primary/60",
                    )}
                    style={{ height: "100%" }}
                  />
                  {errorPct > 0 && !isFuture && (
                    <div
                      className="absolute left-0 right-0 top-0 bg-destructive/80"
                      style={{ height: `${errorPct}%` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Hour labels */}
        <div className="mt-1 flex justify-between">
          {LABEL_HOURS.map((h) => (
            <span key={h} className="font-mono text-[9px] text-muted-foreground/60">
              {String(h).padStart(2, "0")}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
