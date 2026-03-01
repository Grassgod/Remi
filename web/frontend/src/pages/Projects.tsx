import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { IconTrash } from "../components/icons";
import * as api from "../api/client";
import type { ProjectMap } from "../api/types";

export function Projects() {
  const [projects, setProjects] = useState<ProjectMap>({});
  const [adding, setAdding] = useState(false);
  const [newAlias, setNewAlias] = useState("");
  const [newPath, setNewPath] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editPath, setEditPath] = useState("");

  const fetchProjects = async () => {
    try {
      const data = await api.getProjects();
      setProjects(data);
    } catch { /* ignore */ }
  };

  useEffect(() => { fetchProjects(); }, []);

  const entries = Object.entries(projects);

  const handleAdd = async () => {
    if (!newAlias.trim() || !newPath.trim()) return;
    await api.createProject(newAlias.trim(), newPath.trim());
    setNewAlias(""); setNewPath(""); setAdding(false);
    fetchProjects();
  };

  const handleDelete = async (alias: string) => {
    if (!confirm(`删除项目 "${alias}"？`)) return;
    await api.deleteProject(alias);
    fetchProjects();
  };

  const handleEdit = async (alias: string) => {
    if (!editPath.trim()) return;
    await api.updateProject(alias, editPath.trim());
    setEditing(null); setEditPath("");
    fetchProjects();
  };

  const inputStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)", fontSize: 11,
    background: "rgba(var(--glow-primary-rgb), 0.04)",
    border: "1px solid rgba(var(--glow-primary-rgb), 0.2)",
    borderRadius: 3, padding: "6px 10px",
    color: "var(--text-bright)", outline: "none",
    width: "100%",
  };

  const btnStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1,
    textTransform: "uppercase", color: "var(--glow-primary)",
    padding: "5px 12px", border: "1px solid rgba(var(--glow-primary-rgb), 0.2)",
    borderRadius: 3, background: "rgba(var(--glow-primary-rgb), 0.04)",
    cursor: "pointer", transition: "all 0.2s",
  };

  return (
    <Layout title="Projects" subtitle="WORKSPACE MANAGEMENT">
      <HudPanel
        title="Registered Projects"
        action={{ label: "+ Add", onClick: () => setAdding(true) }}
        maxHeight={600}
        delay={0}
      >
        {/* Add form */}
        {adding && (
          <div style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border-glow)",
            display: "flex", gap: 8, alignItems: "center",
          }}>
            <input
              style={{ ...inputStyle, flex: "0 0 120px", width: "auto" }}
              placeholder="别名 (如 remi)"
              value={newAlias}
              onChange={e => setNewAlias(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
              autoFocus
            />
            <input
              style={{ ...inputStyle, flex: 1 }}
              placeholder="路径 (如 /data00/home/hehuajie/project/remi)"
              value={newPath}
              onChange={e => setNewPath(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
            />
            <button style={btnStyle} onClick={handleAdd}>Save</button>
            <button style={{ ...btnStyle, color: "var(--text-dim)", borderColor: "rgba(255,255,255,0.1)" }} onClick={() => { setAdding(false); setNewAlias(""); setNewPath(""); }}>Cancel</button>
          </div>
        )}

        {entries.length === 0 && !adding ? (
          <div style={{
            padding: 40, textAlign: "center",
            fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)",
          }}>NO PROJECTS REGISTERED</div>
        ) : (
          <div>
            {/* Header */}
            <div style={{
              display: "grid", gridTemplateColumns: "120px 1fr auto",
              padding: "8px 16px", gap: 10,
              borderBottom: "1px solid var(--border-glow)",
            }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--text-dim)" }}>ALIAS</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--text-dim)" }}>PATH</span>
              <span style={{ width: 60 }} />
            </div>
            {/* Rows */}
            {entries.map(([alias, path]) => (
              <div key={alias} style={{
                display: "grid", gridTemplateColumns: "120px 1fr auto",
                padding: "10px 16px", gap: 10, alignItems: "center",
                transition: "background 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(var(--glow-primary-rgb), 0.03)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{
                  fontFamily: "var(--font-display)", fontSize: 12, fontWeight: 600,
                  color: "var(--glow-primary)", letterSpacing: 1,
                }}>{alias}</span>

                {editing === alias ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      style={{ ...inputStyle, flex: 1 }}
                      value={editPath}
                      onChange={e => setEditPath(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") handleEdit(alias);
                        if (e.key === "Escape") { setEditing(null); setEditPath(""); }
                      }}
                      autoFocus
                    />
                    <button style={{ ...btnStyle, fontSize: 8, padding: "3px 8px" }} onClick={() => handleEdit(alias)}>OK</button>
                  </div>
                ) : (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)", fontSize: 11,
                      color: "var(--text-muted)", wordBreak: "break-all",
                      cursor: "pointer",
                    }}
                    onClick={() => { setEditing(alias); setEditPath(path); }}
                    title="点击编辑路径"
                  >{path}</span>
                )}

                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={() => handleDelete(alias)}
                    style={{
                      background: "transparent", border: "1px solid rgba(var(--glow-red-rgb), 0.2)",
                      borderRadius: 3, padding: "4px 6px", cursor: "pointer",
                      color: "var(--text-dim)", transition: "all 0.2s",
                      display: "flex", alignItems: "center",
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = "rgba(var(--glow-red-rgb), 0.5)";
                      e.currentTarget.style.color = "var(--glow-red)";
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = "rgba(var(--glow-red-rgb), 0.2)";
                      e.currentTarget.style.color = "var(--text-dim)";
                    }}
                  ><IconTrash /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </HudPanel>

      <div style={{ marginTop: 16 }}>
        <HudPanel title="Usage" delay={0.1} maxHeight={200}>
          <div style={{
            padding: "14px 16px",
            fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.8,
            color: "var(--text-muted)",
          }}>
            <div>在飞书中使用：</div>
            <div style={{ color: "var(--glow-primary)" }}>/p &lt;alias&gt;</div>
            <div style={{ paddingLeft: 16 }}>切换到已注册的项目目录</div>
            <div style={{ color: "var(--glow-primary)", marginTop: 4 }}>/p</div>
            <div style={{ paddingLeft: 16 }}>查看当前项目和可用列表</div>
            <div style={{ color: "var(--glow-primary)", marginTop: 4 }}>/p reset</div>
            <div style={{ paddingLeft: 16 }}>清除项目绑定，回到默认目录</div>
          </div>
        </HudPanel>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .main-content { padding-bottom: calc(var(--bottom-nav-height) + var(--safe-bottom) + 14px) !important; }
        }
      `}</style>
    </Layout>
  );
}
