import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { Search, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemoryStore } from "../stores/memory";
import { MemoryTreeSidebar } from "../components/MemoryTreeSidebar";
import { RecallDebugPanel } from "../components/RecallDebugPanel";
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";

export function Memory() {
  const {
    entities, globalMemory, dailyDates, dailyContent, searchResults,
    projectMemories, projectFileContent,
    activeView, setActiveView,
    fetchEntities, fetchGlobalMemory, fetchDailyDates, fetchDaily, search,
    fetchProjectMemories, fetchProjectFile,
  } = useMemoryStore();
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    fetchEntities();
    fetchGlobalMemory();
    fetchDailyDates();
    fetchProjectMemories();
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

  const { currentEntity, fetchEntity, deleteEntity: storeDeleteEntity } = useMemoryStore();

  const handleTreeNavigate = (view: string) => {
    // If navigating to a specific entity, show inline
    if (view.startsWith("entity:")) {
      const parts = view.split(":");
      const type = parts[1];
      const name = parts.slice(2).join(":");
      fetchEntity(type, name);
    }
    // If navigating to a project file, fetch its content
    if (view.startsWith("project-file:")) {
      const rest = view.replace("project-file:", "");
      const colonIdx = rest.indexOf(":");
      const projectId = rest.slice(0, colonIdx);
      const filePath = rest.slice(colonIdx + 1);
      fetchProjectFile(projectId, filePath);
    }
    setActiveView(view);
  };

  // Also handle clicking entities in the list → show inline
  const openEntityInline = (type: string, name: string) => {
    fetchEntity(type, name);
    setActiveView(`entity:${type}:${name}`);
  };

  const handleDeleteEntity = async () => {
    if (!currentEntity) return;
    if (confirm(`Delete "${currentEntity.name}"?`)) {
      await storeDeleteEntity(currentEntity.type, currentEntity.name);
      setActiveView("entities");
    }
  };

  // Filter entities based on active view
  const filteredEntities = (() => {
    if (activeView.startsWith("type:")) {
      const type = activeView.replace("type:", "");
      return entities.filter(e => e.type === type);
    }
    // Default: show all entities (excluding types that have their own tree sections)
    return entities;
  })();

  const viewTitle = (() => {
    if (activeView.startsWith("type:")) {
      const type = activeView.replace("type:", "");
      const labels: Record<string, string> = {
        person: "People", software: "Software", decision: "Decisions",
        device: "Devices", service: "Services", project: "Projects",
        platform: "Platforms", organization: "Organizations",
      };
      return labels[type] || type;
    }
    return "All Entities";
  })();

  return (
    <Layout title="Memory" subtitle="Knowledge Base">
      {/* Search - always visible */}
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
                onClick={() => {
                  if (r.source === "entity") {
                    const entity = entities.find(e => e.name === r.name);
                    if (entity) {
                      openEntityInline(entity.type, entity.name);
                    }
                  } else if (r.source === "daily") {
                    setSelectedDate(r.name); // r.name is the date string
                    setActiveView("daily");
                  } else if (r.source === "global") {
                    setActiveView("global");
                  } else if (r.source === "project") {
                    // path format: "projectId:filePath"
                    const [projectId, ...rest] = r.path.split(":");
                    const filePath = rest.join(":");
                    fetchProjectFile(projectId, filePath);
                    setActiveView(`project-file:${projectId}:${filePath}`);
                  }
                  setQuery("");
                }}
              >
                <Badge variant="outline" className={cn("min-w-[52px] justify-center text-[9px] uppercase", entityBadgeClass(r.source))}>
                  {r.source}
                </Badge>
                <span className="flex-1 text-sm font-medium">{r.name}</span>
                {r.snippet && <span className="max-w-[200px] truncate text-xs text-muted-foreground">{r.snippet}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Main layout: Tree Sidebar + Content */}
      {!query && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
          {/* Tree Sidebar */}
          <MemoryTreeSidebar
            entities={entities}
            projectMemories={projectMemories}
            activeView={activeView}
            onNavigate={handleTreeNavigate}
          />

          {/* Content Panel */}
          <div>
            {/* Inline Entity Detail */}
            {activeView.startsWith("entity:") && currentEntity && (
              <EntityDetailInline
                entity={currentEntity}
                onBack={() => setActiveView("entities")}
                onBackToType={() => setActiveView(`type:${currentEntity.type}`)}
                onDelete={handleDeleteEntity}
              />
            )}

            {activeView === "global" && <MemoryEditor />}

            {activeView.startsWith("project-file:") && (
              <ProjectFileViewer
                activeView={activeView}
                content={projectFileContent}
                projectMemories={projectMemories}
              />
            )}

            {activeView === "daily" && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Daily Logs</CardTitle>
                </CardHeader>
                <CardContent>
                  {dailyDates.length === 0 ? (
                    <div className="p-6 text-center text-xs text-muted-foreground">No daily logs</div>
                  ) : (
                    <>
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
                      {selectedDate && dailyContent && (
                        <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border bg-muted/30 p-4 text-xs">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{dailyContent}</ReactMarkdown>
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            )}

            {activeView === "recall" && <RecallDebugPanel />}

            {(activeView === "entities" || activeView.startsWith("type:")) && (
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm">
                    {viewTitle}
                    <Badge variant="secondary" className="ml-2 text-[10px]">{filteredEntities.length}</Badge>
                  </CardTitle>
                  <Button variant="ghost" size="sm" onClick={fetchEntities} className="h-7">
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  <ScrollArea className="max-h-[600px]">
                    {filteredEntities.length === 0 ? (
                      <div className="p-8 text-center text-xs text-muted-foreground">No entities found</div>
                    ) : (
                      filteredEntities.map((e, i) => (
                        <div
                          key={i}
                          className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/30"
                          onClick={() => openEntityInline(e.type, e.name)}
                        >
                          <Badge variant="outline" className={cn("min-w-[52px] justify-center text-[9px] uppercase", entityBadgeClass(e.type))}>
                            {e.type}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium">{e.name}</div>
                            {e.summary && <div className="mt-0.5 truncate text-xs text-muted-foreground">{e.summary}</div>}
                          </div>
                          <span className="text-[10px] text-muted-foreground">{e.updatedAt?.slice(5, 10)}</span>
                        </div>
                      ))
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}

function MemoryEditor() {
  const { globalMemory, saveGlobalMemory } = useMemoryStore();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Soul.md</CardTitle>
      </CardHeader>
      <CardContent>
        <MarkdownFileViewer content={globalMemory} onSave={saveGlobalMemory} />
      </CardContent>
    </Card>
  );
}

function EntityDetailInline({ entity, onBack, onBackToType, onDelete }: {
  entity: import("../api/types").EntityDetail;
  onBack: () => void;
  onBackToType: () => void;
  onDelete: () => void;
}) {
  const handleSave = async (content: string) => {
    const api = await import("../api/client");
    await api.updateEntity(entity.type, entity.name, content);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <button onClick={onBack} className="hover:text-foreground transition-colors">Memory</button>
            <span>/</span>
            <button onClick={onBackToType} className="hover:text-foreground transition-colors capitalize">{entity.type}s</button>
            <span>/</span>
            <span className="text-foreground font-medium">{entity.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className={cn("text-[10px] uppercase", entityBadgeClass(entity.type))}>
              {entity.type}
            </Badge>
            <CardTitle className="text-lg">{entity.name}</CardTitle>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onDelete} className="h-7 text-xs text-destructive hover:text-destructive">
          Delete
        </Button>
      </CardHeader>
      <CardContent>
        {/* Metadata */}
        <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          {entity.createdAt && (
            <div><span className="text-muted-foreground">Created</span><div className="font-medium">{entity.createdAt.slice(0, 10)}</div></div>
          )}
          {entity.updatedAt && (
            <div><span className="text-muted-foreground">Updated</span><div className="font-medium">{entity.updatedAt.slice(0, 10)}</div></div>
          )}
          {entity.summary && (
            <div className="col-span-2"><span className="text-muted-foreground">Summary</span><div className="font-medium">{entity.summary}</div></div>
          )}
        </div>
        {(entity.aliases?.length > 0 || entity.tags?.length > 0) && (
          <div className="mb-4 flex flex-wrap gap-3 border-t border-border pt-3 text-xs">
            {entity.aliases?.length > 0 && (
              <div>
                <span className="mr-1 text-[10px] uppercase text-muted-foreground">Aliases:</span>
                {entity.aliases.map(a => <Badge key={a} variant="secondary" className="mr-1 text-[10px]">{a}</Badge>)}
              </div>
            )}
            {entity.tags?.length > 0 && (
              <div>
                <span className="mr-1 text-[10px] uppercase text-muted-foreground">Tags:</span>
                {entity.tags.map(t => <Badge key={t} variant="outline" className="mr-1 text-[10px]">{t}</Badge>)}
              </div>
            )}
          </div>
        )}
        <MarkdownFileViewer content={entity.body || entity.content || ""} onSave={handleSave} />
      </CardContent>
    </Card>
  );
}

function ProjectFileViewer({ activeView, content, projectMemories }: {
  activeView: string;
  content: string;
  projectMemories: import("../api/types").ProjectMemory[];
}) {
  const rest = activeView.replace("project-file:", "");
  const colonIdx = rest.indexOf(":");
  const projectId = rest.slice(0, colonIdx);
  const filePath = rest.slice(colonIdx + 1);
  const pm = projectMemories.find(p => p.projectId === projectId);
  const projectName = pm?.projectName || projectId;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Memory</span>
            <span>/</span>
            <span>{projectName}</span>
            <span>/</span>
            <span className="text-foreground font-medium">{filePath}</span>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="text-[10px] uppercase border-green-500/30 text-green-500 bg-green-500/5">
              Project Memory
            </Badge>
            <CardTitle className="text-lg">{filePath}</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <MarkdownFileViewer content={content} readOnly />
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
    entity: "border-green-500/30 text-green-500 bg-green-500/5",
    daily: "border-amber-500/30 text-amber-500 bg-amber-500/5",
    global: "border-blue-500/30 text-blue-500 bg-blue-500/5",
  };
  return map[type] ?? "";
}

function dayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] || "";
}
