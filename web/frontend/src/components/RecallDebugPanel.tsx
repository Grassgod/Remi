import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";
import { Search, Play, ChevronDown, ChevronRight, ArrowRight } from "lucide-react";
import { useMemoryStore } from "../stores/memory";

export function RecallDebugPanel() {
  const { recallResult, recallLoading, runRecall } = useMemoryStore();
  const [query, setQuery] = useState("");
  const [expandedLayer, setExpandedLayer] = useState<number | null>(null);

  const handleRun = () => {
    if (!query.trim()) return;
    setExpandedLayer(null);
    runRecall(query.trim());
  };

  return (
    <div className="space-y-4">
      {/* Query Input */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Recall Debug</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Enter recall query..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRun()}
                className="pl-9"
              />
            </div>
            <Button onClick={handleRun} disabled={recallLoading || !query.trim()} size="sm">
              <Play className="mr-1.5 h-3.5 w-3.5" />
              {recallLoading ? "Running..." : "Run"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Pipeline Visualization */}
      {recallResult && (
        <>
          {/* Summary */}
          <Card>
            <CardContent className="py-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  Query: <span className="font-medium text-foreground">"{recallResult.query}"</span>
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {recallResult.totalMs}ms total
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Pipeline Steps */}
          <div className="space-y-2">
            {recallResult.layers.map((layer, i) => {
              const isExpanded = expandedLayer === i;
              const hasMatches = layer.matches.length > 0;
              return (
                <Card key={i} className={cn(
                  "transition-colors",
                  layer.ran
                    ? layer.candidateCount > 0 ? "border-green-500/20" : "border-yellow-500/20"
                    : "border-border opacity-60"
                )}>
                  <CardContent className="py-2.5 px-4">
                    {/* Layer Header */}
                    <div
                      className={cn("flex items-center gap-3", hasMatches && "cursor-pointer")}
                      onClick={() => hasMatches && setExpandedLayer(isExpanded ? null : i)}
                    >
                      {/* Status indicator */}
                      <div className={cn(
                        "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold",
                        layer.ran
                          ? layer.candidateCount > 0
                            ? "bg-green-500/10 text-green-500"
                            : "bg-yellow-500/10 text-yellow-500"
                          : "bg-muted text-muted-foreground"
                      )}>
                        {layer.ran ? (layer.candidateCount > 0 ? "✓" : "○") : "—"}
                      </div>

                      {/* Layer name */}
                      <div className="flex-1">
                        <div className="text-xs font-medium">{layer.name}</div>
                        {!layer.ran && layer.reason && (
                          <div className="text-[10px] text-muted-foreground">{layer.reason}</div>
                        )}
                      </div>

                      {/* Metrics */}
                      {layer.ran && (
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-[9px]">
                            {layer.durationMs}ms
                          </Badge>
                          <Badge variant={layer.candidateCount > 0 ? "default" : "secondary"} className="text-[9px]">
                            {layer.candidateCount} {layer.candidateCount === 1 ? "match" : "matches"}
                          </Badge>
                          {layer.exitedEarly && (
                            <Badge className="bg-green-500/10 text-green-500 text-[9px]">
                              early exit
                            </Badge>
                          )}
                        </div>
                      )}

                      {/* Expand arrow */}
                      {hasMatches && (
                        isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>

                    {/* Expanded matches */}
                    {isExpanded && hasMatches && (
                      <div className="mt-2.5 space-y-1 border-t border-border pt-2.5">
                        {layer.matches.map((m, j) => (
                          <div key={j} className="flex items-center gap-2 text-xs">
                            <Badge variant="outline" className={cn("min-w-[50px] justify-center text-[9px]", sourceColor(m.source))}>
                              {m.source}
                            </Badge>
                            <span className="font-medium">{m.name}</span>
                            {m.snippet && (
                              <span className="truncate text-muted-foreground">{m.snippet}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Pipeline Flow Arrow */}
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            {recallResult.layers.map((layer, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className={cn(
                  "rounded px-2 py-0.5 text-[9px] font-mono",
                  layer.ran
                    ? layer.candidateCount > 0 ? "bg-green-500/10 text-green-500" : "bg-yellow-500/10 text-yellow-500"
                    : "bg-muted text-muted-foreground"
                )}>
                  L{i + 1}
                </div>
                {i < recallResult.layers.length - 1 && (
                  <ArrowRight className="h-3 w-3" />
                )}
              </div>
            ))}
          </div>

          {/* Result */}
          {recallResult.result && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Result</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground">
                  {recallResult.result}
                </pre>
              </CardContent>
            </Card>
          )}

          {!recallResult.result && (
            <Card>
              <CardContent className="py-6 text-center text-xs text-muted-foreground">
                No results found for this query.
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function sourceColor(source: string): string {
  const map: Record<string, string> = {
    entity: "border-green-500/30 text-green-500",
    daily: "border-amber-500/30 text-amber-500",
    "memory-section": "border-blue-500/30 text-blue-500",
    vector: "border-purple-500/30 text-purple-500",
    project: "border-cyan-500/30 text-cyan-500",
  };
  return map[source] ?? "";
}
