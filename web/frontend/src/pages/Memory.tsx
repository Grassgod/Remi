import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { ScrollArea } from "../components/ui/scroll-area";
import { Search, Brain, FileText, Calendar, RefreshCw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMemoryStore } from "../stores/memory";
import * as api from "../api/client";
import type { EntityDetail } from "../api/types";

export function Memory() {
  const {
    entities, globalMemory, dailyDates, dailyContent, searchResults,
    fetchEntities, fetchGlobalMemory, fetchDailyDates, fetchDaily, search,
  } = useMemoryStore();
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("entities");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Entity sheet
  const [sheetEntity, setSheetEntity] = useState<EntityDetail | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    fetchEntities();
    fetchGlobalMemory();
    fetchDailyDates();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (selectedDate) fetchDaily(selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    if (dailyDates.length > 0 && !selectedDate) setSelectedDate(dailyDates[0].date);
  }, [dailyDates]);

  const openEntity = async (type: string, name: string) => {
    try {
      const detail = await api.getEntity(type, name);
      setSheetEntity(detail);
      setSheetOpen(true);
    } catch {}
  };

  const deleteEntity = async () => {
    if (!sheetEntity) return;
    await api.deleteEntity(sheetEntity.type, sheetEntity.name);
    setSheetOpen(false);
    setSheetEntity(null);
    fetchEntities();
  };

  return (
    <Layout title="Memory" subtitle="Knowledge Base">
      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search memory..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Search Results */}
      {query && searchResults.length > 0 && (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Search Results</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {searchResults.map((r, i) => (
              <div
                key={i}
                className="flex cursor-pointer items-center gap-2.5 px-4 py-2 transition-colors hover:bg-accent/30"
                onClick={() => { if (r.source !== "daily") openEntity(r.source, r.name); }}
              >
                <Badge variant="outline" className={cn("min-w-[52px] justify-center text-[9px] uppercase", entityBadgeClass(r.source))}>
                  {r.source}
                </Badge>
                <span className="flex-1 text-sm font-medium">{r.name}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      {!query && (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="entities">
              <Brain className="mr-1.5 h-3.5 w-3.5" /> Entities
            </TabsTrigger>
            <TabsTrigger value="global">
              <FileText className="mr-1.5 h-3.5 w-3.5" /> MEMORY.md
            </TabsTrigger>
            <TabsTrigger value="daily">
              <Calendar className="mr-1.5 h-3.5 w-3.5" /> Daily Logs
            </TabsTrigger>
          </TabsList>

          {/* Entities Tab */}
          <TabsContent value="entities">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm">
                  Entities <Badge variant="secondary" className="ml-2 text-[10px]">{entities.length}</Badge>
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={fetchEntities} className="h-7">
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="max-h-[500px]">
                  {entities.length === 0 ? (
                    <div className="p-8 text-center text-xs text-muted-foreground">No entities found</div>
                  ) : (
                    entities.map((e, i) => (
                      <div
                        key={i}
                        className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/30"
                        onClick={() => openEntity(e.type, e.name)}
                      >
                        <Badge variant="outline" className={cn("min-w-[52px] justify-center text-[9px] uppercase", entityBadgeClass(e.type))}>
                          {e.type}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">{e.name}</div>
                          {e.summary && <div className="mt-0.5 truncate text-xs text-muted-foreground">{e.summary}</div>}
                        </div>
                        {e.tags?.length > 0 && (
                          <div className="hidden gap-1 sm:flex">
                            {e.tags.slice(0, 3).map(tag => (
                              <Badge key={tag} variant="outline" className="text-[8px]">{tag}</Badge>
                            ))}
                          </div>
                        )}
                        <span className="text-[10px] text-muted-foreground">{e.updatedAt?.slice(5, 10)}</span>
                      </div>
                    ))
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* MEMORY.md Tab */}
          <TabsContent value="global">
            <MemoryEditor />
          </TabsContent>

          {/* Daily Logs Tab */}
          <TabsContent value="daily">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Daily Logs</CardTitle>
              </CardHeader>
              <CardContent>
                {dailyDates.length === 0 ? (
                  <div className="p-6 text-center text-xs text-muted-foreground">No daily logs</div>
                ) : (
                  <>
                    {/* Date selector */}
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {dailyDates.slice(0, 14).map(entry => (
                        <Button
                          key={entry.date}
                          variant={selectedDate === entry.date ? "default" : "outline"}
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setSelectedDate(entry.date)}
                        >
                          {entry.date.slice(5)} {dayOfWeek(entry.date)}
                        </Button>
                      ))}
                    </div>

                    {/* Inline content */}
                    {selectedDate && dailyContent && (
                      <div className="rounded-md border border-border bg-muted/30 p-4">
                        <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
                          {dailyContent}
                        </pre>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {/* Entity Detail Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" onClose={() => setSheetOpen(false)} className="w-full max-w-md overflow-y-auto sm:max-w-lg">
          {sheetEntity && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Badge variant="outline" className={cn("text-[10px] uppercase", entityBadgeClass(sheetEntity.type))}>
                    {sheetEntity.type}
                  </Badge>
                  {sheetEntity.name}
                </SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-4 p-6 pt-0">
                {/* Metadata grid */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  {sheetEntity.createdAt && (
                    <div>
                      <div className="text-muted-foreground">Created</div>
                      <div className="font-medium">{sheetEntity.createdAt.slice(0, 10)}</div>
                    </div>
                  )}
                  {sheetEntity.updatedAt && (
                    <div>
                      <div className="text-muted-foreground">Updated</div>
                      <div className="font-medium">{sheetEntity.updatedAt.slice(0, 10)}</div>
                    </div>
                  )}
                  {sheetEntity.aliases?.length > 0 && (
                    <div className="col-span-2">
                      <div className="text-muted-foreground">Aliases</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {sheetEntity.aliases.map(a => (
                          <Badge key={a} variant="secondary" className="text-[10px]">{a}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {sheetEntity.tags?.length > 0 && (
                    <div className="col-span-2">
                      <div className="text-muted-foreground">Tags</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {sheetEntity.tags.map(t => (
                          <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Content */}
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">Content</div>
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
                      {sheetEntity.body || sheetEntity.content}
                    </pre>
                  </div>
                </div>

                {/* Delete button */}
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full"
                  onClick={deleteEntity}
                >
                  <Trash2 className="mr-2 h-3 w-3" /> Delete Entity
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </Layout>
  );
}

function MemoryEditor() {
  const { globalMemory, saveGlobalMemory } = useMemoryStore();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setText(globalMemory); }, [globalMemory]);

  const handleSave = async () => {
    setSaving(true);
    await saveGlobalMemory(text);
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">MEMORY.md</CardTitle>
        <Button variant="outline" size="sm" onClick={handleSave} disabled={saving} className="h-7 text-xs">
          {saving ? "Saving..." : "Save"}
        </Button>
      </CardHeader>
      <CardContent>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          className="min-h-[400px] w-full resize-y rounded-md border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-input"
          spellCheck={false}
        />
      </CardContent>
    </Card>
  );
}

function entityBadgeClass(type: string): string {
  const map: Record<string, string> = {
    person: "border-blue-500/30 text-blue-500 bg-blue-500/5",
    project: "border-green-500/30 text-green-500 bg-green-500/5",
    service: "border-purple-500/30 text-purple-500 bg-purple-500/5",
    platform: "border-indigo-500/30 text-indigo-500 bg-indigo-500/5",
    organization: "border-amber-500/30 text-amber-500 bg-amber-500/5",
    decision: "border-red-500/30 text-red-500 bg-red-500/5",
    software: "border-cyan-500/30 text-cyan-500 bg-cyan-500/5",
  };
  return map[type] ?? "";
}

function dayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] || "";
}
