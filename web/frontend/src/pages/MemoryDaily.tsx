import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { useMemoryStore } from "../stores/memory";

export function MemoryDaily() {
  const params = useParams<{ date: string }>();
  const { dailyContent, dailyDates, fetchDaily, fetchDailyDates } = useMemoryStore();
  const [, setLocation] = useLocation();
  const date = params.date ?? "";

  useEffect(() => {
    if (!dailyDates.length) fetchDailyDates();
  }, []);

  useEffect(() => {
    if (date) fetchDaily(date);
  }, [date]);

  return (
    <Layout title="Memory" subtitle={`DAILY / ${date}`}>
      <button
        onClick={() => setLocation("/memory")}
        className="mb-4 rounded-md border border-border bg-transparent px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >← Back</button>

      <div className="mb-4 flex flex-wrap gap-2">
        {dailyDates.map(entry => (
          <button
            key={entry.date}
            onClick={() => setLocation(`/memory/daily/${entry.date}`)}
            className={`rounded-md border px-2.5 py-1 font-mono text-[10px] tracking-wide transition-colors
              ${entry.date === date
                ? "border-foreground/20 bg-accent text-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
          >{entry.date}</button>
        ))}
      </div>

      <HudPanel title={`Log — ${date}`} maxHeight={700}>
        <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground">
          {dailyContent || "No data for this date."}
        </pre>
      </HudPanel>
    </Layout>
  );
}
