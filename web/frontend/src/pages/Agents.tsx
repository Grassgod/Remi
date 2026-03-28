import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { MarkdownFileViewer } from "../components/MarkdownFileViewer";
import { SkillTreeNode } from "../components/SkillTreeNode";
import {
  Bot, RefreshCw, ChevronLeft, Play, Timer,
  AlertTriangle, Activity, Check, XCircle,
  Cpu, Zap, Clock, Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAgentsStore } from "../stores/agents";
import * as api from "../api/client";
import type { AgentInfo, AgentRunEntry, McpServerInfo, SkillFileNode } from "../api/types";

export function Agents() {
  const {
    agents, selectedAgent, detail, runs, mcpServers,
    loading, fetchAgents, selectAgent, fetchMcpServers,
    saveClaudeMd, saveSettings, saveSkill,
  } = useAgentsStore();

  useEffect(() => {
    selectAgent(null);
    fetchAgents();
    fetchMcpServers();
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
          mcpServers={mcpServers}
          loading={loading}
          onBack={() => selectAgent(null)}
          onSaveClaudeMd={(content) => saveClaudeMd(selectedAgent, content)}
          onSaveSettings={(content) => saveSettings(selectedAgent, content)}
          onSaveSkill={(skillName, content) => saveSkill(selectedAgent, skillName, content)}
        />
      </Layout>
    );
  }

  return (
    <Layout title="Agents" subtitle="CONFIGURATION">
      {/* Stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={<Bot className="h-4 w-4" />} label="Total Agents" value={String(agents.length)} sub={`${cronCount} cron · ${onDemandCount} other`} />
        <StatCard icon={<Cpu className="h-4 w-4" />} label="Models" value={[...new Set(agents.map(a => a.model))].join(", ") || "\u2014"} sub={`${agents.filter(a => a.model === "opus").length} opus · ${agents.filter(a => a.model === "haiku").length} haiku`} />
        <StatCard icon={<Timer className="h-4 w-4" />} label="Avg Duration" value={avgDuration > 0 ? formatDuration(avgDuration) : "\u2014"} sub="Last run" />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Success Rate" value={agents.length > 0 ? `${Math.round(agents.reduce((s, a) => s + a.successRate7d, 0) / agents.length)}%` : "\u2014"} sub="7-day average" variant={totalErrors7d > 0 ? "warning" : "success"} />
      </div>

      {/* Agent Cards */}
      <Card className="mb-3">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Bot className="h-4 w-4 text-muted-foreground" />
            Agent Registry
            <Badge variant="secondary" className="text-[10px]">{agents.length}</Badge>
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={fetchAgents} className="h-7 text-xs text-muted-foreground">
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          {agents.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">No agents registered</div>
          ) : (
            agents.map(agent => (
              <AgentCard key={agent.name} agent={agent} onClick={() => selectAgent(agent.name)} />
            ))
          )}
        </CardContent>
      </Card>

      {/* MCP Servers */}
      {mcpServers.length > 0 && (
        <Card>
          <CardHeader className="space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Server className="h-4 w-4 text-muted-foreground" />
              MCP Servers
              <Badge variant="secondary" className="text-[10px]">{mcpServers.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <McpTable servers={mcpServers} />
          </CardContent>
        </Card>
      )}
    </Layout>
  );
}

// ── Agent Card ────────────────────────────────────────

function AgentCard({ agent, onClick }: { agent: AgentInfo; onClick: () => void }) {
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

function AgentDetailView({ agent, detail, runs, mcpServers, loading, onBack, onSaveClaudeMd, onSaveSettings, onSaveSkill }: {
  agent: AgentInfo;
  detail: import("../api/types").AgentDetail;
  runs: AgentRunEntry[];
  mcpServers: McpServerInfo[];
  loading: boolean;
  onBack: () => void;
  onSaveClaudeMd: (content: string) => Promise<void>;
  onSaveSettings: (content: string) => Promise<void>;
  onSaveSkill: (skillName: string, content: string) => Promise<void>;
}) {
  // Resolve MCP tools to their servers
  const agentMcpServers = mcpServers.filter(s =>
    agent.permissions.mcpTools.some(t => t.startsWith(`mcp__${s.name.replace(/-/g, "-")}__`))
  );

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

          {/* MCP Servers used by this agent */}
          {agentMcpServers.length > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">MCP Servers</div>
              {agentMcpServers.map(s => (
                <div key={s.name} className="flex items-center gap-2 text-xs">
                  <Server className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono font-medium">{s.name}</span>
                  <span className="text-muted-foreground">{s.command} {s.args.join(" ")}</span>
                </div>
              ))}
            </div>
          )}
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

// ── MCP Table ─────────────────────────────────────────

function McpTable({ servers }: { servers: McpServerInfo[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Command</TableHead>
          <TableHead className="hidden sm:table-cell">Args</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {servers.map(s => (
          <TableRow key={s.name}>
            <TableCell className="font-mono text-xs font-medium">{s.name}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{s.command}</TableCell>
            <TableCell className="hidden max-w-[300px] truncate font-mono text-xs text-muted-foreground sm:table-cell" title={s.args.join(" ")}>
              {s.args.join(" ")}
            </TableCell>
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
