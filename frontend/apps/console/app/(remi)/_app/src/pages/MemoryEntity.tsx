import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "~remiadmin/lib/utils";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useMemoryStore } from "../stores/memory";
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";

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

export function MemoryEntity() {
  const params = useParams<{ type: string; name: string }>();
  const { currentEntity, fetchEntity, deleteEntity } = useMemoryStore();
  const [, setLocation] = useLocation();

  const type = params.type ?? "";
  const name = decodeURIComponent(params.name ?? "");

  useEffect(() => {
    if (type && name) fetchEntity(type, name);
  }, [type, name]);

  const handleDelete = async () => {
    if (confirm(`Delete entity "${name}"?`)) {
      await deleteEntity(type, name);
      setLocation("/memory");
    }
  };

  if (!currentEntity) {
    return (
      <Layout title="Memory" subtitle="Entity">
        <div className="flex h-[40vh] items-center justify-center text-xs text-muted-foreground">Loading...</div>
      </Layout>
    );
  }

  return (
    <Layout title="Memory" subtitle="Entity">
      {/* Breadcrumb */}
      <div className="mb-4 flex items-center gap-2 text-xs">
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setLocation("/memory")}>
          <ArrowLeft className="h-3 w-3" /> Memory
        </Button>
        <span className="text-muted-foreground">/</span>
        <span className="text-muted-foreground capitalize">{currentEntity.type}s</span>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{currentEntity.name}</span>
      </div>

      {/* Header */}
      <Card className="mb-4">
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="flex items-center gap-3">
            <Badge variant="outline" className={cn("text-[10px] uppercase", entityBadgeClass(currentEntity.type))}>
              {currentEntity.type}
            </Badge>
            <CardTitle className="text-lg">{currentEntity.name}</CardTitle>
          </div>
          <Button variant="destructive" size="sm" onClick={handleDelete} className="h-7 text-xs">
            <Trash2 className="mr-1.5 h-3 w-3" /> Delete
          </Button>
        </CardHeader>
        <CardContent>
          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-4">
            {currentEntity.createdAt && (
              <div>
                <div className="mb-0.5 text-muted-foreground">Created</div>
                <div className="font-medium">{currentEntity.createdAt.slice(0, 10)}</div>
              </div>
            )}
            {currentEntity.updatedAt && (
              <div>
                <div className="mb-0.5 text-muted-foreground">Updated</div>
                <div className="font-medium">{currentEntity.updatedAt.slice(0, 10)}</div>
              </div>
            )}
            {currentEntity.summary && (
              <div className="col-span-2">
                <div className="mb-0.5 text-muted-foreground">Summary</div>
                <div className="font-medium">{currentEntity.summary}</div>
              </div>
            )}
          </div>

          {/* Tags & Aliases */}
          {(currentEntity.aliases?.length > 0 || currentEntity.tags?.length > 0) && (
            <div className="mt-3 flex flex-wrap gap-3 border-t border-border pt-3">
              {currentEntity.aliases?.length > 0 && (
                <div>
                  <span className="mr-1.5 text-[10px] uppercase text-muted-foreground">Aliases:</span>
                  {currentEntity.aliases.map(a => (
                    <Badge key={a} variant="secondary" className="mr-1 text-[10px]">{a}</Badge>
                  ))}
                </div>
              )}
              {currentEntity.tags?.length > 0 && (
                <div>
                  <span className="mr-1.5 text-[10px] uppercase text-muted-foreground">Tags:</span>
                  {currentEntity.tags.map(t => (
                    <Badge key={t} variant="outline" className="mr-1 text-[10px]">{t}</Badge>
                  ))}
                </div>
              )}
            </div>
          )}

        </CardContent>
      </Card>

      {/* Content */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Content</CardTitle>
        </CardHeader>
        <CardContent>
          <MarkdownFileViewer
            content={currentEntity.body || currentEntity.content || "(empty)"}
            metadata={currentEntity.metadata}
            knownFields={["type", "name", "created", "updated", "aliases", "tags", "summary"]}
            readOnly
          />
        </CardContent>
      </Card>
    </Layout>
  );
}
