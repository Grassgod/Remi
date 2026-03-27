import { useEffect } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { FileText, RefreshCw, Search, Filter, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLogsStore } from "../stores/logs";

const LEVEL_BADGE_VARIANT: Record<string, "outline" | "secondary" | "warning" | "destructive"> = {
  DEBUG: "outline",
  INFO: "secondary",
  WARN: "warning",
  ERROR: "destructive",
};

export function Logs() {
  const {
    entries, total, hasMore, loading, error, modules,
    date, level, module, traceId,
    fetchLogs, fetchModules, setFilter, loadMore,
  } = useLogsStore();

  useEffect(() => {
    fetchLogs();
    fetchModules();
  }, []);

  const handleFilterChange = (key: "date" | "level" | "module" | "traceId", value: string | null) => {
    setFilter(key, value);
    setTimeout(() => useLogsStore.getState().fetchLogs(), 0);
    if (key === "date") {
      setTimeout(() => useLogsStore.getState().fetchModules(), 0);
    }
  };

  return (
    <Layout title="Logs" subtitle="STRUCTURED LOGS">
      {/* Filter Bar */}
      <Card className="mb-4">
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="hidden h-4 w-4 text-muted-foreground sm:block" />

            <Input
              type="date"
              value={date}
              onChange={e => handleFilterChange("date", e.target.value)}
              className="h-8 w-auto font-mono text-xs"
            />

            <Select
              value={level ?? ""}
              onChange={e => handleFilterChange("level", (e.target as HTMLSelectElement).value || null)}
              placeholder="All Levels"
              options={[
                { value: "DEBUG", label: "DEBUG" },
                { value: "INFO", label: "INFO" },
                { value: "WARN", label: "WARN" },
                { value: "ERROR", label: "ERROR" },
              ]}
              className="h-8 w-[130px] font-mono text-xs"
            />

            <Select
              value={module ?? ""}
              onChange={e => handleFilterChange("module", (e.target as HTMLSelectElement).value || null)}
              placeholder="All Modules"
              options={modules.map(m => ({ value: m, label: m }))}
              className="h-8 w-[150px] font-mono text-xs"
            />

            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Trace ID..."
                value={traceId ?? ""}
                onChange={e => handleFilterChange("traceId", e.target.value || null)}
                className="h-8 w-[140px] pl-7 font-mono text-xs"
              />
            </div>

            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {total} entries
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Logs Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Log Entries
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => { fetchLogs(); fetchModules(); }}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            {loading ? "Loading..." : "Refresh"}
          </Button>
        </CardHeader>

        <CardContent className="p-0">
          {error && (
            <div className="px-4 py-2 font-mono text-xs text-destructive">
              {error}
            </div>
          )}

          {entries.length === 0 ? (
            <div className="px-4 py-12 text-center font-mono text-xs text-muted-foreground">
              {loading ? "LOADING..." : "NO LOG ENTRIES"}
            </div>
          ) : (
            <ScrollArea className="max-h-[600px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[100px] font-mono text-[10px] uppercase tracking-wider">
                      Time
                    </TableHead>
                    <TableHead className="w-[80px] font-mono text-[10px] uppercase tracking-wider">
                      Level
                    </TableHead>
                    <TableHead className="hidden w-[110px] font-mono text-[10px] uppercase tracking-wider sm:table-cell">
                      Module
                    </TableHead>
                    <TableHead className="font-mono text-[10px] uppercase tracking-wider">
                      Message
                    </TableHead>
                    <TableHead className="hidden w-[120px] font-mono text-[10px] uppercase tracking-wider md:table-cell">
                      Trace
                    </TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {entries.map((entry, i) => (
                    <TableRow
                      key={i}
                      className={cn(
                        entry.level === "ERROR" && "border-l-2 border-l-destructive/40",
                        entry.level === "WARN" && "border-l-2 border-l-warning/30",
                      )}
                    >
                      <TableCell className="py-1.5 font-mono text-[11px] text-muted-foreground">
                        {formatLogTime(entry.ts)}
                      </TableCell>
                      <TableCell className="py-1.5">
                        <Badge
                          variant={LEVEL_BADGE_VARIANT[entry.level] ?? "outline"}
                          className={cn(
                            "font-mono text-[10px]",
                            entry.level === "INFO" && "border-chart-1/30 bg-chart-1/10 text-chart-1",
                          )}
                        >
                          {entry.level}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden truncate py-1.5 font-mono text-[11px] text-muted-foreground sm:table-cell">
                        {entry.module}
                      </TableCell>
                      <TableCell
                        className="max-w-0 truncate py-1.5 font-mono text-[11px]"
                        title={entry.msg}
                      >
                        {entry.msg}
                      </TableCell>
                      <TableCell className="hidden py-1.5 md:table-cell">
                        {entry.traceId ? (
                          <button
                            className="truncate font-mono text-[10px] text-primary hover:underline"
                            onClick={() => {
                              window.location.hash = `#/traces?traceId=${entry.traceId}`;
                            }}
                          >
                            {entry.traceId.slice(0, 12)}
                          </button>
                        ) : (
                          <span className="font-mono text-[10px] text-muted-foreground/40">
                            —
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Load More */}
              {hasMore && (
                <div className="border-t border-border p-0">
                  <Button
                    variant="ghost"
                    className="h-auto w-full rounded-none py-2.5 font-mono text-xs text-primary"
                    onClick={loadMore}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                    LOAD MORE ({total - entries.length} remaining)
                  </Button>
                </div>
              )}
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}

// ── Helpers ──

function formatLogTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  } catch {
    return ts.slice(11, 23);
  }
}
