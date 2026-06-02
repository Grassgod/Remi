import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";
import { SkillTreeNode } from "../components/SkillTreeNode";
import {
  Bot, RefreshCw, ChevronLeft, Timer,
  AlertTriangle, Activity, Check, XCircle,
  Cpu, Zap, Plus, Trash2, AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAgentsStore } from "../stores/agents";
import * as api from "../api/client";
import { request } from "../api/client";
import type { AgentInfo, AgentRunEntry, SkillFileNode } from "../api/types";
import { PageHeader, StatTile, EmptyState, staggerStyle } from "../components/configkit";

export function Agents() {
  const {
    agents, selectedAgent, detail, runs,
    loading, fetchAgents, selectAgent,
    saveClaudeMd, saveSettings, saveSkill,
  } = useAgentsStore();

  // CRUD dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", description: "" });
  const [addError, setAddError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCreate = async () => {
    setAddError(null);
    if (!addForm.name) { setAddError("Name is required"); return; }
    try {
      await request("/api/v1/agents", {
        method: "POST",
        body: JSON.stringify({ name: addForm.name, description: addForm.description }),
      });
      setAddOpen(false);
      setAddForm({ name: "", description: "" });
      fetchAgents();
    } catch (e: any) {
      setAddError(e.message);
    }
  };

  const handleDelete = async (name: string) => {
    setActionError(null);
    try {
      await request(`/api/v1/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
      setDeleteConfirm(null);
      fetchAgents();
    } catch (e: any) {
      setActionError(e.message);
    }
  };

  useEffect(() => {
    selectAgent(null);
    fetchAgents();
  }, []);

  const totalErrors7d = agents.reduce((s, a) => s + (100 - a.successRate7d) * a.runsToday / 100, 0);
  const avgDuration = agents.length > 0
    ? agents.reduce((s, a) => s + (a.lastRun?.duration_ms ?? 0), 0) / agents.filter(a => a.lastRun).length || 0
    : 0;
  const cronCount = agents.filter(a => a.trigger === "cron").length;
  const onDemandCount = agents.filter(a => a.trigger !== "cron").length;

  // Detail view for selected agent
  if (selectedAgent && detail) {
    const agent = agents.find(a => a.name === selectedAgent);
    return (
      <Layout title="Agents" subtitle="CONFIGURATION">
        <AgentDetailView
          agent={agent!}
          detail={detail}
          runs={runs}
          loading={loading}
          onBack={() => selectAgent(null)}
          onSaveClaudeMd={(content) => saveClaudeMd(selectedAgent, content)}
          onSaveSettings={(content) => saveSettings(selectedAgent, content)}
          onSaveSkill={(skillName, content) => saveSkill(selectedAgent, skillName, content)}
        />
      </Layout>
    );
  }

  const avgDurationDisplay = avgDuration > 0 ? formatDuration(avgDuration) : "—";
  const avgPct = agents.length > 0 ? Math.round(agents.reduce((s, a) => s + a.successRate7d, 0) / agents.length) : 0;
  const successRateDisplay = agents.length > 0 ? `${avgPct}%` : "—";

  return (
    <Layout title="Agents" subtitle="CONFIGURATION">
      <PageHeader
        icon={Bot}
        title="Agents"
        subtitle="Registered AI agents — schedules, models, and run history."
        count={agents.length}
        countLabel="registered"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={fetchAgents} className="h-7 text-xs">
              <RefreshCw className="mr-1 h-3 w-3" /> Refresh
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)} className="h-7 text-xs">
              <Plus className="mr-1 h-3 w-3" /> New Agent
            </Button>
          </>
        }
      />

      {actionError && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" /> {actionError}
        </div>
      )}

      {/* Stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={<Bot className="h-4 w-4" />} label="Total Agents" value={String(agents.length)} sub={`${cronCount} cron · ${onDemandCount} other`} />
        <StatCard icon={<Cpu className="h-4 w-4" />} label="Models" value={[...new Set(agents.map(a => a.model))].join(", ") || "\u2014"} sub={`${agents.filter(a => a.model === "opus").length} opus · ${agents.filter(a => a.model === "haiku").length} haiku`} />
        <StatCard icon={<Timer className="h-4 w-4" />} label="Avg Duration" value={avgDuration > 0 ? formatDuration(avgDuration) : "\u2014"} sub="Last run" />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Success Rate" value={agents.length > 0 ? `${Math.round(agents.reduce((s, a) => s + a.successRate7d, 0) / agents.length)}%` : "\u2014"} sub="7-day average" variant={totalErrors7d > 0 ? "warning" : "success"} />
      </div>

      {/* Agent Cards */}
      {agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Scaffold one to start drafting its CLAUDE.md and skills. Runtime registration still requires editing src/agents/registry.ts."
          action={
            <Button size="sm" onClick={() => setAddOpen(true)} className="h-7 text-xs">
              <Plus className="mr-1 h-3 w-3" /> Create draft
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {agents.map((agent, i) => (
            <div key={agent.name} style={staggerStyle(i, 80, 60)}>
              <AgentCard
                agent={agent}
                onClick={() => selectAgent(agent.name)}
                onDelete={() => setDeleteConfirm(agent.name)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Agent (draft)</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <input
              value={addForm.name}
              onChange={(e) => setAddForm(f => ({ ...f, name: e.target.value }))}
              placeholder="agent-name (alphanumeric + dashes)"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm outline-none focus:border-input"
            />
            <textarea
              value={addForm.description}
              onChange={(e) => setAddForm(f => ({ ...f, description: e.target.value }))}
              placeholder="What does this agent do? (becomes the registry description in CLAUDE.md)"
              rows={4}
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:border-input"
            />
            <p className="text-[11px] text-muted-foreground">
              Scaffolds <code className="rounded bg-muted/40 px-1">~/.remi/agents/&lt;name&gt;/.claude/</code> with starter
              files. Schedule it by adding to <code className="rounded bg-muted/40 px-1">src/agents/registry.ts</code>
              and restarting the daemon.
            </p>
          </div>
          {addError && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-3 w-3" /> {addError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Delete agent</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground">
            Remove <span className="font-mono font-medium text-foreground">{deleteConfirm}</span>'s
            on-disk content? Registry-registered agents are protected.
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

// ── Agent Card ────────────────────────────────────────

function AgentCard({ agent, onClick, onDelete }: { agent: AgentInfo; onClick: () => void; onDelete?: () => void }) {
  const triggerColor = agent.trigger === "cron"
    ? "border-blue-500/30 text-blue-500 bg-blue-500/5"
    : agent.trigger === "debounce"
    ? "border-amber-500/30 text-amber-500 bg-amber-500/5"
    : "border-green-500/30 text-green-500 bg-green-500/5";

  const modelColor = agent.model === "opus"
    ? "border-purple-500/30 text-purple-500 bg-purple-500/5"
    : "border-cyan-500/30 text-cyan-500 bg-cyan-500/5";

  return (
    <div
      className="cursor-pointer rounded-lg border border-border p-4 transition-all hover:border-primary/30 hover:bg-accent/20"
      onClick={onClick}
    >
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn(
            "h-2.5 w-2.5 rounded-full",
            !agent.lastRun ? "bg-muted-foreground" :
            agent.lastRun.exit === 0 ? "bg-success" : "bg-destructive"
          )} />
          <span className="font-mono text-sm font-medium">{agent.name}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className={cn("text-[9px]", modelColor)}>{agent.model}</Badge>
          <Badge variant="outline" className={cn("text-[9px]", triggerColor)}>{agent.trigger}</Badge>
          {!agent.mcp && <Badge variant="outline" className="text-[9px] text-muted-foreground">no mcp</Badge>}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="ml-1 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title="Delete agent"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      <div className="mb-3 text-xs text-muted-foreground">{agent.description || "(no description)"}</div>

      {/* Config grid */}
      <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
        <div>
          <span className="text-[10px] uppercase text-muted-foreground">CWD</span>
          <div className="truncate font-mono">{agent.cwd}</div>
        </div>
        <div>
          <span className="text-[10px] uppercase text-muted-foreground">Schedule</span>
          <div className="font-mono">{agent.cron || (agent.debounce_ms ? `${agent.debounce_ms / 1000}s debounce` : "on-demand")}</div>
        </div>
        <div>
          <span className="text-[10px] uppercase text-muted-foreground">Timeout</span>
          <div className="font-mono">{formatDuration(agent.timeoutMs)}</div>
        </div>
        <div>
          <span className="text-[10px] uppercase text-muted-foreground">Last Run</span>
          <div className="font-mono">{agent.lastRun ? formatAgo(agent.lastRun.ts) : "\u2014"}</div>
        </div>
      </div>

      {/* Permissions & Skills */}
      <div className="flex flex-wrap gap-1.5">
        {agent.permissions.mcpTools.map(t => (
          <Badge key={t} variant="outline" className="text-[9px] border-purple-500/20 text-purple-400">
            {t.replace("mcp__remi-memory__", "mcp:")}
          </Badge>
        ))}
        {agent.permissions.cliTools.map(t => (
          <Badge key={t} variant="outline" className="text-[9px] border-blue-500/20 text-blue-400">
            {t.replace("(*)", "")}
          </Badge>
        ))}
        {agent.skills.map(s => (
          <Badge key={s} variant="outline" className="text-[9px] border-green-500/20 text-green-400">
            skill:{s}
          </Badge>
        ))}
      </div>

      {/* Run stats footer */}
      <div className="mt-3 flex items-center gap-4 border-t border-border pt-2 text-[10px] text-muted-foreground">
        <span>Today: <strong className="text-foreground">{agent.runsToday}</strong> runs</span>
        <span>7d success: <strong className={cn(agent.successRate7d >= 90 ? "text-success" : "text-warning")}>{agent.successRate7d}%</strong></span>
        {agent.lastRun && (
          <span>Duration: <strong className="text-foreground">{formatDuration(agent.lastRun.duration_ms)}</strong></span>
        )}
      </div>
    </div>
  );
}

// ── Agent Detail View ─────────────────────────────────

function AgentDetailView({ agent, detail, runs, loading, onBack, onSaveClaudeMd, onSaveSettings, onSaveSkill }: {
  agent: AgentInfo;
  detail: import("../api/types").AgentDetail;
  runs: AgentRunEntry[];
  loading: boolean;
  onBack: () => void;
  onSaveClaudeMd: (content: string) => Promise<void>;
  onSaveSettings: (content: string) => Promise<void>;
  onSaveSkill: (skillName: string, content: string) => Promise<void>;
}) {
  return (
    <>
      {/* Breadcrumb */}
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-3 h-7 text-xs text-muted-foreground">
        <ChevronLeft className="mr-1 h-3 w-3" /> Back to Agents
      </Button>

      {/* Header Card */}
      <Card className="mb-3">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bot className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg font-mono">{agent.name}</CardTitle>
              <Badge variant="outline" className="text-[10px]">{agent.model}</Badge>
              <Badge variant="outline" className="text-[10px]">{agent.trigger}</Badge>
            </div>
            <div className={cn(
              "flex items-center gap-1.5 text-xs",
              agent.lastRun?.exit === 0 ? "text-success" : "text-destructive"
            )}>
              {agent.lastRun?.exit === 0 ? <Check className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
              {agent.lastRun ? `Last: ${formatAgo(agent.lastRun.ts)}` : "Never run"}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-5">
            <div><span className="text-[10px] uppercase text-muted-foreground">CWD</span><div className="font-mono">{agent.cwd}</div></div>
            <div><span className="text-[10px] uppercase text-muted-foreground">Schedule</span><div className="font-mono">{agent.cron || (agent.debounce_ms ? `${agent.debounce_ms / 1000}s` : "on-demand")}</div></div>
            <div><span className="text-[10px] uppercase text-muted-foreground">Timeout</span><div className="font-mono">{formatDuration(agent.timeoutMs)}</div></div>
            <div><span className="text-[10px] uppercase text-muted-foreground">MCP</span><div className="font-mono">{agent.mcp ? "enabled" : "disabled"}</div></div>
            <div><span className="text-[10px] uppercase text-muted-foreground">Success Rate (7d)</span><div className="font-mono">{agent.successRate7d}%</div></div>
          </div>

          {/* Permissions */}
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
            {agent.permissions.mcpTools.map(t => (
              <Badge key={t} variant="outline" className="text-[9px] border-purple-500/20 text-purple-400">
                {t.replace("mcp__remi-memory__", "mcp:")}
              </Badge>
            ))}
            {agent.permissions.cliTools.map(t => (
              <Badge key={t} variant="outline" className="text-[9px] border-blue-500/20 text-blue-400">
                {t.replace("(*)", "")}
              </Badge>
            ))}
          </div>

        </CardContent>
      </Card>

      {/* CLAUDE.md */}
      <Card className="mb-3">
        <CardHeader className="space-y-0 pb-2">
          <CardTitle className="text-sm">CLAUDE.md</CardTitle>
        </CardHeader>
        <CardContent>
          <MarkdownFileViewer content={detail.claudeMd} onSave={onSaveClaudeMd} />
        </CardContent>
      </Card>

      {/* Settings */}
      <Card className="mb-3">
        <CardHeader className="space-y-0 pb-2">
          <CardTitle className="text-sm">settings.local.json</CardTitle>
        </CardHeader>
        <CardContent>
          <JsonCodeViewer content={detail.settingsJson} onSave={onSaveSettings} />
        </CardContent>
      </Card>

      {/* Skills */}
      {detail.skills.map(skill => (
        <AgentSkillCard
          key={skill.name}
          agentName={agent.name}
          skill={skill}
          onSave={(content) => onSaveSkill(skill.name, content)}
        />
      ))}

      {/* Run History */}
      <Card>
        <CardHeader className="space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Run History
            <Badge variant="secondary" className="text-[10px]">{runs.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-[400px]">
            <RunHistoryTable runs={runs} />
          </ScrollArea>
        </CardContent>
      </Card>
    </>
  );
}

// ── Run History Table ─────────────────────────────────

// ── Agent Skill Card with file tree ──────────────────

function AgentSkillCard({ agentName, skill, onSave }: {
  agentName: string;
  skill: { name: string; content: string };
  onSave: (content: string) => Promise<void>;
}) {
  const [tree, setTree] = useState<SkillFileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState("SKILL.md");
  const [fileContent, setFileContent] = useState(skill.content);

  useEffect(() => {
    api.getAgentSkillTree(agentName, skill.name).then(setTree).catch(() => setTree([]));
  }, [agentName, skill.name]);

  useEffect(() => {
    if (selectedFile === "SKILL.md") {
      setFileContent(skill.content);
      return;
    }
    api.getAgentSkillFile(agentName, skill.name, selectedFile)
      .then(d => setFileContent(d.content))
      .catch(() => setFileContent("(failed to load)"));
  }, [selectedFile, agentName, skill.name]);

  const handleSelect = (_skillName: string, filePath: string) => {
    setSelectedFile(filePath);
  };

  return (
    <Card className="mb-3">
      <CardHeader className="space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Zap className="h-4 w-4 text-muted-foreground" />
          Skill: {skill.name}
          {selectedFile !== "SKILL.md" && (
            <span className="font-mono text-xs font-normal text-muted-foreground">/ {selectedFile}</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {tree.length > 1 ? (
          <div className="grid grid-cols-[180px_1fr] gap-3">
            {/* File tree */}
            <ScrollArea className="max-h-[400px] rounded-md border border-border bg-muted/20 py-1">
              {tree.map(node => (
                <SkillTreeNode
                  key={node.path}
                  node={node}
                  skillName={skill.name}
                  selectedFile={selectedFile}
                  onSelect={handleSelect}
                  depth={0}
                />
              ))}
            </ScrollArea>
            {/* File content */}
            <MarkdownFileViewer
              content={fileContent}
              onSave={selectedFile === "SKILL.md" ? onSave : undefined}
              readOnly={selectedFile !== "SKILL.md" || !selectedFile.endsWith(".md")}
            />
          </div>
        ) : (
          <MarkdownFileViewer
            content={fileContent}
            onSave={onSave}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ── Run History Table ─────────────────────────────────

function RunHistoryTable({ runs }: { runs: AgentRunEntry[] }) {
  if (runs.length === 0) {
    return <div className="p-8 text-center text-xs text-muted-foreground">No runs recorded</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Model</TableHead>
          <TableHead className="text-center">Exit</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Output</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run, i) => (
          <TableRow key={`${run.ts}-${i}`}>
            <TableCell className="font-mono text-xs text-muted-foreground">{formatTime(run.ts)}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{run.model}</TableCell>
            <TableCell className="text-center">
              <Badge variant={run.exit === 0 ? "success" : "destructive"} className="text-[9px]">
                {run.exit === 0 ? <><Check className="mr-0.5 h-2.5 w-2.5" />OK</> : <><XCircle className="mr-0.5 h-2.5 w-2.5" />{run.exit}</>}
              </Badge>
            </TableCell>
            <TableCell className="text-right font-mono text-xs text-muted-foreground">{formatDuration(run.duration_ms)}</TableCell>
            <TableCell className="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell">{run.stdout_len}b</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Stat Card ─────────────────────────────────────────

function StatCard({ icon, label, value, sub, variant }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  variant?: "success" | "warning" | "destructive";
}) {
  return (
    <Card className="transition-colors hover:bg-accent/30">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          {icon}
          <span className="text-[10px] font-medium uppercase tracking-wider">{label}</span>
        </div>
        <div className={cn("mt-2 text-xl font-bold leading-none tracking-tight sm:text-2xl",
          variant === "success" ? "text-success" :
          variant === "warning" ? "text-warning" :
          variant === "destructive" ? "text-destructive" :
          "text-foreground"
        )}>
          {value}
        </div>
        <div className="mt-1.5 truncate text-[10px] text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

// ── JSON Code Viewer ──────────────────────────────────

function JsonCodeViewer({ content, onSave }: { content: string; onSave?: (content: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setText(content); setEditing(false); }, [content]);

  const prettyJson = (() => {
    try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
  })();

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(text);
    } catch { /* caller handles */ }
    setSaving(false);
    setEditing(false);
  };

  return (
    <div className="relative">
      {onSave && (
        <div className="absolute right-2 top-2 z-10 flex gap-1.5">
          {editing && (
            <Button variant="outline" size="sm" onClick={handleSave} disabled={saving} className="h-6 text-[10px]">
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)} className="h-6 text-[10px] text-muted-foreground">
            {editing ? "Preview" : "Edit"}
          </Button>
        </div>
      )}
      {editing ? (
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          className="min-h-[200px] w-full resize-y rounded-md border border-border bg-muted/30 p-4 pt-9 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-input"
          spellCheck={false}
        />
      ) : (
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed text-foreground">
          <code>{prettyJson}</code>
        </pre>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatAgo(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 0) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return ts.slice(0, 19);
  }
}
