import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { ArrowLeft } from "lucide-react";
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
    <Layout title="Memory" subtitle={`Daily / ${date}`}>
      <div className="mb-4 flex items-center gap-2 text-xs">
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setLocation("/memory")}>
          <ArrowLeft className="h-3 w-3" /> Memory
        </Button>
        <span className="text-muted-foreground">/</span>
        <span className="text-muted-foreground">Daily</span>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{date}</span>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {dailyDates.map(entry => (
          <Button
            key={entry.date}
            variant={entry.date === date ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setLocation(`/memory/daily/${entry.date}`)}
          >
            {entry.date.slice(5)}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Log — {date}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border bg-muted/30 p-4">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
              {dailyContent || "No data for this date."}
            </pre>
          </div>
        </CardContent>
      </Card>
    </Layout>
  );
}
