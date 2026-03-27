import { Card, CardContent } from "./ui/card";

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

        {/* Bars — use inline styles for reliable rendering */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 48 }}>
          {data.map((d) => {
            const heightPx = Math.round((d.count / maxCount) * 48);
            const errorPx = d.count > 0 ? Math.round((d.errors / d.count) * heightPx) : 0;
            const normalPx = heightPx - errorPx;
            const isFuture = currentHour !== undefined && d.hour > currentHour;

            return (
              <div
                key={d.hour}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "flex-end",
                  height: 48,
                }}
                title={`${String(d.hour).padStart(2, "0")}:00 — ${d.count} entries${d.errors > 0 ? `, ${d.errors} errors` : ""}`}
              >
                {/* Error portion (top of bar) */}
                {errorPx > 0 && !isFuture && (
                  <div style={{
                    height: errorPx,
                    background: "hsl(0 84% 60%)",
                    borderRadius: heightPx === errorPx ? "2px 2px 0 0" : 0,
                  }} />
                )}
                {/* Normal portion (bottom of bar) */}
                {normalPx > 0 && (
                  <div style={{
                    height: normalPx,
                    background: isFuture ? "hsl(215 20% 25%)" : "hsl(217 91% 50% / 0.6)",
                    borderRadius: errorPx > 0 ? 0 : "2px 2px 0 0",
                  }} />
                )}
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
