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
      <button onClick={() => setLocation("/memory")} style={{
        fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 1,
        color: "var(--glow-primary)", background: "transparent",
        border: "1px solid rgba(var(--glow-primary-rgb), 0.2)",
        borderRadius: 3, padding: "4px 12px", cursor: "pointer",
        marginBottom: 16, transition: "all 0.2s",
      }}>← BACK</button>

      {/* Date navigation */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {dailyDates.map(entry => (
          <button key={entry.date} onClick={() => setLocation(`/memory/daily/${entry.date}`)} style={{
            fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 1,
            padding: "4px 10px", borderRadius: 3, cursor: "pointer",
            border: `1px solid ${entry.date === date ? "rgba(var(--glow-primary-rgb), 0.4)" : "var(--border-glow)"}`,
            background: entry.date === date ? "rgba(var(--glow-primary-rgb), 0.08)" : "transparent",
            color: entry.date === date ? "var(--glow-primary)" : "var(--text-muted)",
            transition: "all 0.2s",
          }}>{entry.date}</button>
        ))}
      </div>

      <HudPanel title={`Log — ${date}`} maxHeight={700} delay={0}>
        <pre style={{
          padding: 16, margin: 0,
          fontFamily: "var(--font-mono)", fontSize: 11,
          lineHeight: 1.7, color: "var(--text-primary)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{dailyContent || "No data for this date."}</pre>
      </HudPanel>
    </Layout>
  );
}
