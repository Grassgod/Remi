import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { Zap, FileText, Clock, ChevronRight, ChevronDown, FolderOpen, ToggleLeft, ToggleRight, Plus, Trash2, AlertCircle } from "lucide-react";
import { request } from "../api/client";
import { cn } from "@/lib/utils";
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";
import { SkillTreeNode } from "../components/SkillTreeNode";
import * as api from "../api/client";
import type { SkillInfo, SkillFileNode, SkillScope } from "../api/types";

interface CCSwitchSkill {
  id: string;
  name: string;
  apps: Record<string, boolean>;
}

const APP_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

type Tab = "file" | "reports";

export function Skills() {
  const [scopes, setScopes] = useState<SkillScope[]>([]);
  const [activeScope, setActiveScope] = useState<string>("");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [basePath, setBasePath] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState("SKILL.md");
  const [skillTree, setSkillTree] = useState<SkillFileNode[]>([]);
  const [tab, setTab] = useState<Tab>("file");
  const [fileContent, setFileContent] = useState("");
  const [reportDates, setReportDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [reportContent, setReportContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
  const [ccSkills, setCcSkills] = useState<CCSwitchSkill[]>([]);

  // Install / Uninstall (cc-switch managed skills)
  const [installOpen, setInstallOpen] = useState(false);
  const [installForm, setInstallForm] = useState({ sourceDir: "", name: "", description: "" });
  const [installError, setInstallError] = useState<string | null>(null);
  const [uninstallConfirm, setUninstallConfirm] = useState<CCSwitchSkill | null>(null);

  const reloadCcSkills = () => {
    return request("/api/v1/cc-switch/skills")
      .then((res: any) => { if (res.skills) setCcSkills(res.skills); })
      .catch(() => {});
  };

  useEffect(() => { reloadCcSkills(); }, []);

  const handleInstall = async () => {
    setInstallError(null);
    if (!installForm.sourceDir) { setInstallError("Source directory is required"); return; }
    try {
      await request("/api/v1/cc-switch/skills", {
        method: "POST",
        body: JSON.stringify({
          sourceDir: installForm.sourceDir,
          name: installForm.name || undefined,
          description: installForm.description || undefined,
        }),
      });
      setInstallOpen(false);
      setInstallForm({ sourceDir: "", name: "", description: "" });
      await reloadCcSkills();
    } catch (e: any) {
      setInstallError(e.message);
    }
  };

  const handleUninstall = async (skill: CCSwitchSkill) => {
    try {
      await request(`/api/v1/cc-switch/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
      setUninstallConfirm(null);
      await reloadCcSkills();
    } catch {}
  };

  const ccSkillMap = new Map(ccSkills.map(s => [s.name, s]));

  const handleToggleApp = async (skillName: string, app: string, current: boolean) => {
    const ccId = ccSkills.find(s => s.name === skillName)?.id;
    if (!ccId) return;
    try {
      await api.request(`/api/v1/cc-switch/skills/${encodeURIComponent(ccId)}/toggle`, {
        method: "PUT",
        body: JSON.stringify({ app, enabled: !current }),
      });
      setCcSkills(prev => prev.map(s =>
        s.id === ccId ? { ...s, apps: { ...s.apps, [app]: !current } } : s
      ));
    } catch {}
  };

  // Load scopes on mount
  useEffect(() => {
    api.getSkillScopes().then((scopesData) => {
      setScopes(scopesData);
      // Default to remi-global, fall back to first scope
      const defaultScope = scopesData.find(s => s.scope === "remi-global")?.scope ?? scopesData[0]?.scope ?? "";
      setActiveScope(defaultScope);
    }).catch(() => setLoading(false));
  }, []);

  // Load skills when scope changes
  useEffect(() => {
    if (!activeScope) return;
    setLoading(true);
    setSelected(null);
    setSkillTree([]);
    setFileContent("");
    setExpandedSkills(new Set());
    Promise.all([
      api.getSkills(activeScope),
      api.getSkillsBasePath(activeScope),
    ]).then(([skillsData, baseData]) => {
      setSkills(skillsData);
      setBasePath(baseData.basePath);
      if (skillsData.length > 0) {
        const first = skillsData[0].name;
        setSelected(first);
        setExpandedSkills(new Set([first]));
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [activeScope]);

  // Load tree + file when skill selected
  useEffect(() => {
    if (!selected) return;
    setTab("file");
    setSelectedFile("SKILL.md");
    api.getSkillTree(selected, activeScope).then(setSkillTree).catch(() => setSkillTree([]));
    api.getSkillFile(selected, "SKILL.md", activeScope).then(d => setFileContent(d.content)).catch(() => setFileContent(""));
    const skill = skills.find(s => s.name === selected);
    if (skill?.hasSchedule) {
      api.getSkillReports(selected, activeScope).then(setReportDates).catch(() => setReportDates([]));
    } else {
      setReportDates([]);
    }
    setSelectedDate(null);
    setReportContent("");
  }, [selected]);

  // Load file content when file path changes
  useEffect(() => {
    if (!selected || !selectedFile) return;
    setTab("file");
    api.getSkillFile(selected, selectedFile, activeScope).then(d => setFileContent(d.content)).catch(() => setFileContent(""));
  }, [selectedFile]);

  useEffect(() => {
    if (!selected || !selectedDate) return;
    api.getSkillReport(selected, selectedDate, activeScope).then(d => setReportContent(d.content)).catch(() => setReportContent(""));
  }, [selectedDate]);

  const handleSaveFile = async (content: string) => {
    if (!selected) return;
    await api.putSkillFile(selected, content, selectedFile, activeScope);
    setFileContent(content);
  };

  const toggleSkillExpand = (name: string) => {
    setExpandedSkills(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectSkillFile = (skillName: string, filePath: string) => {
    if (selected !== skillName) {
      setSelected(skillName);
      setExpandedSkills(prev => new Set(prev).add(skillName));
    }
    setSelectedFile(filePath);
  };

  const currentSkill = skills.find(s => s.name === selected);
  const fullPath = selected && basePath ? `${basePath}/${selected}/${selectedFile}` : "";
  const displayPath = fullPath.replace(/^\/home\/[^/]+/, "~");

  return (
    <Layout title="Skills" subtitle="Skill Definitions & Reports">
      {/* Scope selector + install */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {scopes.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            {scopes.map(s => (
              <Button
                key={s.scope}
                variant={activeScope === s.scope ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setActiveScope(s.scope)}
              >
                {s.label}
                <Badge variant="secondary" className="ml-1.5 text-[10px]">{s.count}</Badge>
              </Button>
            ))}
          </div>
        ) : <div />}
        <div className="flex items-center gap-1.5">
          {ccSkills.length > 0 && (
            <Badge variant="outline" className="h-6 text-[10px]">
              {ccSkills.length} cc-switch managed
            </Badge>
          )}
          <Button size="sm" onClick={() => setInstallOpen(true)} className="h-7 text-xs">
            <Plus className="mr-1 h-3 w-3" /> Install Skill
          </Button>
        </div>
      </div>

      {/* cc-switch managed list with uninstall */}
      {ccSkills.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {ccSkills.map(s => (
            <div key={s.id} className="group flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-2.5 py-1 text-[11px]">
              <Zap className="h-3 w-3 text-amber-500" />
              <span className="font-mono">{s.name}</span>
              <button
                onClick={() => setUninstallConfirm(s)}
                className="ml-1 text-muted-foreground/60 transition-colors hover:text-destructive"
                title="Uninstall"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-xs text-muted-foreground">Loading...</div>
      ) : skills.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center">
            <Zap className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">No skills found</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {activeScope ? `No skills in this scope` : `Skills are loaded from ~/.remi/.claude/skills/`}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_1fr]">
          {/* Skill Tree Sidebar */}
          <Card className="lg:sticky lg:top-0">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Zap className="h-4 w-4 text-muted-foreground" />
                Skills
                <Badge variant="secondary" className="ml-auto text-[10px]">{skills.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[600px] px-2 pb-2">
                {skills.map(skill => {
                  const isExpanded = expandedSkills.has(skill.name);
                  const isSelected = selected === skill.name;
                  return (
                    <div key={skill.name}>
                      {/* Skill root */}
                      <div
                        className={cn(
                          "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors",
                          isSelected && !isExpanded
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                          isSelected && isExpanded && "text-foreground"
                        )}
                        onClick={() => {
                          toggleSkillExpand(skill.name);
                          if (selected !== skill.name) {
                            setSelected(skill.name);
                          }
                        }}
                      >
                        {isExpanded
                          ? <ChevronDown className="h-3 w-3 shrink-0" />
                          : <ChevronRight className="h-3 w-3 shrink-0" />}
                        <FolderOpen className="h-3 w-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
                        {skill.hasSchedule && (
                          <Clock className="h-3 w-3 shrink-0 text-green-500" />
                        )}
                      </div>
                      {/* File tree */}
                      {isExpanded && isSelected && skillTree.length > 0 && (
                        <div className="ml-3 border-l border-border pl-1">
                          {skillTree.map(node => (
                            <SkillTreeNode
                              key={node.path}
                              node={node}
                              skillName={skill.name}
                              selectedFile={selectedFile}
                              onSelect={selectSkillFile}
                              depth={0}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Content */}
          <div className="flex flex-col gap-3">
            {currentSkill && (
              <>
                {/* Header */}
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1 font-mono">
                      {displayPath}
                    </div>
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-base">{currentSkill.name}</CardTitle>
                      {currentSkill.hasSchedule && (
                        <>
                          <Badge variant="outline" className="border-green-500/30 text-green-500 bg-green-500/5 text-[10px]">
                            Scheduled
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">{currentSkill.cron}</span>
                        </>
                      )}
                    </div>
                    {currentSkill.description && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{currentSkill.description}</p>
                    )}
                    {/* cc-switch per-app toggles */}
                    {ccSkillMap.has(currentSkill.name) && (
                      <div className="mt-2 flex items-center gap-3 border-t border-border/50 pt-2">
                        {Object.entries(APP_LABELS).map(([app, label]) => {
                          const cc = ccSkillMap.get(currentSkill.name)!;
                          return (
                            <button
                              key={app}
                              onClick={() => handleToggleApp(currentSkill.name, app, cc.apps[app])}
                              className="flex items-center gap-1 text-xs transition-colors"
                            >
                              {cc.apps[app] ? (
                                <ToggleRight className="h-4 w-4 text-primary" />
                              ) : (
                                <ToggleLeft className="h-4 w-4 text-muted-foreground/40" />
                              )}
                              <span className={cc.apps[app] ? "text-foreground" : "text-muted-foreground/50"}>
                                {label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </CardHeader>
                </Card>

                {/* Tabs */}
                <div className="flex gap-1">
                  <Button
                    variant={tab === "file" ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setTab("file")}
                  >
                    {selectedFile}
                  </Button>
                  {reportDates.length > 0 && (
                    <Button
                      variant={tab === "reports" ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        setTab("reports");
                        if (!selectedDate && reportDates.length > 0) setSelectedDate(reportDates[0]);
                      }}
                    >
                      Reports ({reportDates.length})
                    </Button>
                  )}
                </div>

                {/* File Tab */}
                {tab === "file" && (
                  <Card>
                    <CardContent className="pt-4">
                      <MarkdownFileViewer
                        content={fileContent}
                        onSave={selectedFile.endsWith(".md") ? handleSaveFile : undefined}
                        readOnly={!selectedFile.endsWith(".md")}
                      />
                    </CardContent>
                  </Card>
                )}

                {/* Reports Tab */}
                {tab === "reports" && (
                  <Card>
                    <CardContent className="pt-4">
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {reportDates.slice(0, 14).map(date => (
                          <Button
                            key={date}
                            variant={selectedDate === date ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setSelectedDate(date)}
                          >
                            {date.slice(5)}
                          </Button>
                        ))}
                      </div>
                      {selectedDate && reportContent && (
                        <MarkdownFileViewer content={reportContent} readOnly />
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Install dialog */}
      <Dialog open={installOpen} onOpenChange={setInstallOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Install Skill</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <input
              value={installForm.sourceDir}
              onChange={(e) => setInstallForm(f => ({ ...f, sourceDir: e.target.value }))}
              placeholder="Source directory (absolute path)"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm outline-none focus:border-input"
            />
            <input
              value={installForm.name}
              onChange={(e) => setInstallForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Name (optional — defaults to dir name)"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:border-input"
            />
            <input
              value={installForm.description}
              onChange={(e) => setInstallForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Description (optional)"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:border-input"
            />
            <p className="text-[11px] text-muted-foreground">
              Copies the directory into <code className="rounded bg-muted/40 px-1">~/.cc-switch/skills/</code> as the
              SSOT, then symlinks into each enabled tool's skills folder on toggle.
            </p>
          </div>
          {installError && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-3 w-3" /> {installError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setInstallOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleInstall}>Install</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Uninstall confirm */}
      <Dialog open={!!uninstallConfirm} onOpenChange={() => setUninstallConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Uninstall Skill</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground">
            Remove <span className="font-mono font-medium text-foreground">{uninstallConfirm?.name}</span>?
            All symlinks in tool skill dirs + the SSOT copy will be cleared.
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setUninstallConfirm(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => uninstallConfirm && handleUninstall(uninstallConfirm)}>Uninstall</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
