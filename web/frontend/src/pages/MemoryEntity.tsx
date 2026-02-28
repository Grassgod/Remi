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
        <div style={{
          padding: 40, textAlign: "center",
          fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)",
        }}>LOADING...</div>
      </Layout>
    );
  }

  return (
    <Layout title="Memory" subtitle={`ENTITY / ${currentEntity.name}`}>
      {/* Back */}
      <button onClick={() => setLocation("/memory")} style={{
        fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 1,
        color: "var(--glow-primary)", background: "transparent",
        border: "1px solid rgba(var(--glow-primary-rgb), 0.2)",
        borderRadius: 3, padding: "4px 12px", cursor: "pointer",
        marginBottom: 16, transition: "all 0.2s",
      }}>← BACK</button>

      {/* Meta */}
      <HudPanel title="Entity Details" action={{ label: "Delete", onClick: handleDelete }} delay={0}>
        <div style={{ padding: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "8px 16px" }}>
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

      {/* Content */}
      <div style={{ marginTop: 14 }}>
        <HudPanel title="Content" maxHeight={600} delay={0.1}>
          <pre style={{
            padding: 16, margin: 0,
            fontFamily: "var(--font-mono)", fontSize: 11,
            lineHeight: 1.6, color: "var(--text-primary)",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>{currentEntity.content || "(empty)"}</pre>
        </HudPanel>
      </div>
    </Layout>
  );
}

function metaRow(label: string, value: string) {
  return (
    <>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.5,
        textTransform: "uppercase", color: "var(--text-dim)",
      }}>{label}</span>
      <span style={{
        fontFamily: "var(--font-body)", fontSize: 13,
        color: "var(--text-bright)",
      }}>{value}</span>
    </>
  );
}
