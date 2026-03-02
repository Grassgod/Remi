import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { useMemoryStore } from "../stores/memory";

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
      <Layout title="Memory" subtitle="ENTITY">
        <div className="p-10 text-center font-mono text-xs text-muted-foreground">LOADING...</div>
      </Layout>
    );
  }

  return (
    <Layout title="Memory" subtitle={`ENTITY / ${currentEntity.name}`}>
      <button
        onClick={() => setLocation("/memory")}
        className="mb-4 rounded-md border border-border bg-transparent px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >← Back</button>

      <HudPanel title="Entity Details" action={{ label: "Delete", onClick: handleDelete }}>
        <div className="p-4">
          <div className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2">
            {metaRow("TYPE", currentEntity.type)}
            {metaRow("NAME", currentEntity.name)}
            {metaRow("CREATED", currentEntity.createdAt || "—")}
            {metaRow("UPDATED", currentEntity.updatedAt || "—")}
            {currentEntity.aliases?.length > 0 && metaRow("ALIASES", currentEntity.aliases.join(", "))}
            {currentEntity.tags?.length > 0 && metaRow("TAGS", currentEntity.tags.join(", "))}
            {currentEntity.summary && metaRow("SUMMARY", currentEntity.summary)}
          </div>
        </div>
      </HudPanel>

      <div className="mt-3.5">
        <HudPanel title="Content" maxHeight={600}>
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground">
            {currentEntity.content || "(empty)"}
          </pre>
        </HudPanel>
      </div>
    </Layout>
  );
}

function metaRow(label: string, value: string) {
  return (
    <>
      <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{value}</span>
    </>
  );
}
