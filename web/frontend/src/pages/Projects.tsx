import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { IconTrash } from "../components/icons";
import * as api from "../api/client";
import type { ProjectMap } from "../api/types";

const inputCls = "w-full rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground outline-none transition-colors focus:border-input";
const btnCls = "rounded-md border border-border bg-transparent px-3 py-1.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer";

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

  return (
    <Layout title="Projects" subtitle="WORKSPACE MANAGEMENT">
      <HudPanel
        title="Registered Projects"
        action={{ label: "+ Add", onClick: () => setAdding(true) }}
        maxHeight={600}
      >
        {adding && (
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <input
              className={`${inputCls} !w-auto flex-[0_0_120px]`}
              placeholder="别名 (如 remi)"
              value={newAlias}
              onChange={e => setNewAlias(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
              autoFocus
            />
            <input
              className={`${inputCls} flex-1`}
              placeholder="路径 (如 /data00/home/hehuajie/project/remi)"
              value={newPath}
              onChange={e => setNewPath(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
            />
            <button className={btnCls} onClick={handleAdd}>Save</button>
            <button className={btnCls} onClick={() => { setAdding(false); setNewAlias(""); setNewPath(""); }}>Cancel</button>
          </div>
        )}

        {entries.length === 0 && !adding ? (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">NO PROJECTS REGISTERED</div>
        ) : (
          <div>
            <div className="grid grid-cols-[120px_1fr_auto] gap-2.5 border-b border-border px-4 py-2">
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">ALIAS</span>
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">PATH</span>
              <span className="w-[60px]" />
            </div>
            {entries.map(([alias, path]) => (
              <div key={alias} className="grid grid-cols-[120px_1fr_auto] items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-accent/30">
                <span className="font-mono text-xs font-semibold text-foreground">{alias}</span>
                {editing === alias ? (
                  <div className="flex gap-1.5">
                    <input
                      className={`${inputCls} flex-1`}
                      value={editPath}
                      onChange={e => setEditPath(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") handleEdit(alias);
                        if (e.key === "Escape") { setEditing(null); setEditPath(""); }
                      }}
                      autoFocus
                    />
                    <button className={`${btnCls} !px-2 !py-1 !text-[8px]`} onClick={() => handleEdit(alias)}>OK</button>
                  </div>
                ) : (
                  <span
                    className="cursor-pointer break-all font-mono text-xs text-muted-foreground"
                    onClick={() => { setEditing(alias); setEditPath(path); }}
                    title="点击编辑路径"
                  >{path}</span>
                )}
                <div className="flex gap-1">
                  <button
                    onClick={() => handleDelete(alias)}
                    className="flex items-center rounded-md border border-destructive/20 bg-transparent p-1.5 text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive"
                  ><IconTrash /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </HudPanel>

      <div className="mt-4">
        <HudPanel title="Usage" maxHeight={200}>
          <div className="p-4 font-mono text-xs leading-relaxed text-muted-foreground">
            <div>在飞书中使用：</div>
            <div className="text-foreground">/p &lt;alias&gt;</div>
            <div className="pl-4">切换到已注册的项目目录</div>
            <div className="mt-1 text-foreground">/p</div>
            <div className="pl-4">查看当前项目和可用列表</div>
            <div className="mt-1 text-foreground">/p reset</div>
            <div className="pl-4">清除项目绑定，回到默认目录</div>
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
