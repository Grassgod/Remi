# Mission Module Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Mission module with three view modes (List grouped by status, Kanban restyled, Detail page with conversation flow), using Linear-inspired dark theme.

**Architecture:** Refactor monolithic `Missions.tsx` into a page shell with view toggle + three sub-components (MissionListView, MissionKanbanView, MissionDetail). Shared constants for status config. Detail page at `/missions/:id` with pipeline progress bar and conversation flow reusing existing APIs.

**Tech Stack:** React 19, wouter (hash routing), Tailwind CSS, shadcn/ui, lucide-react, existing Hono API

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `web/frontend/src/pages/Missions.tsx` | Rewrite | Page shell: view toggle (list/kanban), data fetch, pass to sub-views |
| `web/frontend/src/pages/MissionDetail.tsx` | Create | Detail page: pipeline progress, sidebar info, conversation flow |
| `web/frontend/src/components/missions/mission-constants.ts` | Create | Shared status config (colors, labels, order), step labels, formatters |
| `web/frontend/src/components/missions/MissionListView.tsx` | Create | Grouped-by-status list view |
| `web/frontend/src/components/missions/MissionKanbanView.tsx` | Create | Restyled kanban 4-column view |
| `web/frontend/src/components/missions/PipelineProgress.tsx` | Create | Step progress bar for detail page |
| `web/frontend/src/api/types.ts` | Modify (add) | Add `MissionDetail` type with contract field |
| `web/frontend/src/api/client.ts` | Modify (add) | Add `getMissionDetail()` returning full mission with contract |
| `web/frontend/src/App.tsx` | Modify | Add `/missions/:id` route |

Working directory: `/data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign/`

All paths below are relative to `web/frontend/src/`.

---

### Task 1: Shared Constants & Types

**Files:**
- Create: `components/missions/mission-constants.ts`
- Modify: `api/types.ts`
- Modify: `api/client.ts`

- [ ] **Step 1: Create mission-constants.ts**

```typescript
// components/missions/mission-constants.ts

export interface StatusConfig {
  key: string;
  label: string;
  color: string;        // hex color for dots, left bars
  bgColor: string;      // badge background (with alpha)
  textColor: string;    // badge text
  defaultCollapsed: boolean;
}

export const STATUS_ORDER: StatusConfig[] = [
  { key: "blocked",     label: "Blocked",     color: "#f87171", bgColor: "#450a0a", textColor: "#f87171", defaultCollapsed: false },
  { key: "in_progress", label: "In Progress", color: "#fb923c", bgColor: "#422006", textColor: "#fb923c", defaultCollapsed: false },
  { key: "inbox",       label: "Inbox",       color: "#a1a1aa", bgColor: "#27272a", textColor: "#a1a1aa", defaultCollapsed: false },
  { key: "in_review",   label: "In Review",   color: "#a78bfa", bgColor: "#1e1b4b", textColor: "#a78bfa", defaultCollapsed: false },
  { key: "approved",    label: "Approved",    color: "#60a5fa", bgColor: "#172554", textColor: "#60a5fa", defaultCollapsed: false },
  { key: "done",        label: "Done",        color: "#4ade80", bgColor: "#052e16", textColor: "#4ade80", defaultCollapsed: true },
  { key: "rejected",    label: "Rejected",    color: "#f87171", bgColor: "#450a0a", textColor: "#f87171", defaultCollapsed: true },
];

export const KANBAN_COLUMNS = ["inbox", "in_progress", "in_review", "done"] as const;

export const STEP_LABELS: Record<string, string> = {
  intake: "Intake",
  rfc: "RFC",
  decompose: "Decompose",
  execute: "Execute",
  eval: "Eval",
  summary: "Summary",
};

export const PIPELINE_STEPS = ["intake", "rfc", "decompose", "execute", "eval", "summary"] as const;

export function getStatusConfig(status: string): StatusConfig {
  return STATUS_ORDER.find(s => s.key === status) ?? STATUS_ORDER[2]; // default to inbox
}

export function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatNum(n: number): string {
  if (n > 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n > 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
```

- [ ] **Step 2: Add MissionDetail type to api/types.ts**

Add after the existing `MissionItem` interface (around line 317):

```typescript
export interface MissionDetailItem extends MissionItem {
  contract: {
    cases: Array<{
      id: string;
      description: string;
      input: string;
      expectedOutput: string;
      type: "unit" | "integration" | "e2e";
    }>;
    acceptanceCriteria: string[];
    verificationResults?: {
      caseResults: Array<{ caseId: string; passed: boolean; detail: string }>;
      overallPassed: boolean;
      verifiedAt: string;
    };
  } | null;
  outputDir: string | null;
}
```

- [ ] **Step 3: Add getMissionDetail to api/client.ts**

Add after `getMission` (around line 159):

```typescript
export const getMissionDetail = (id: string) =>
  request<import("./types").MissionDetailItem>(`/api/v1/missions/${id}`);
```

- [ ] **Step 4: Commit**

```bash
git add web/frontend/src/components/missions/mission-constants.ts web/frontend/src/api/types.ts web/frontend/src/api/client.ts
git commit -m "feat(missions): add shared constants, types, and detail API"
```

---

### Task 2: List View Component

**Files:**
- Create: `components/missions/MissionListView.tsx`

- [ ] **Step 1: Create MissionListView.tsx**

```tsx
// components/missions/MissionListView.tsx
import { useState } from "react";
import { useLocation } from "wouter";
import { GitPullRequest, ChevronRight, User } from "lucide-react";
import type { MissionItem } from "../../api/types";
import {
  STATUS_ORDER,
  STEP_LABELS,
  getStatusConfig,
  formatRelative,
  formatCost,
} from "./mission-constants";

interface MissionListViewProps {
  missions: MissionItem[];
}

export function MissionListView({ missions }: MissionListViewProps) {
  const [, navigate] = useLocation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const s of STATUS_ORDER) {
      if (s.defaultCollapsed) init[s.key] = true;
    }
    return init;
  });

  const toggleCollapse = (key: string) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Group missions by status in STATUS_ORDER
  const groups = STATUS_ORDER
    .map(cfg => ({
      cfg,
      items: missions.filter(m => m.status === cfg.key),
    }))
    .filter(g => g.items.length > 0);

  return (
    <div className="space-y-5">
      {groups.map(({ cfg, items }) => (
        <div key={cfg.key}>
          {/* Group header */}
          <button
            onClick={() => toggleCollapse(cfg.key)}
            className="flex w-full items-center gap-2 px-1 py-1 text-left"
          >
            <span
              className="h-[7px] w-[7px] flex-shrink-0 rounded-full"
              style={{ background: cfg.color }}
            />
            <span
              className="text-[11px] font-medium uppercase tracking-wider"
              style={{ color: cfg.color }}
            >
              {cfg.label}
            </span>
            <span className="text-[10px] text-zinc-600">{items.length}</span>
            <span className="ml-1 flex-1 border-t border-zinc-800" />
            <span className="text-[10px] text-zinc-600">
              {collapsed[cfg.key] ? "▸" : "▾"}
            </span>
          </button>

          {/* Items */}
          {!collapsed[cfg.key] && (
            <div className="mt-1 space-y-1">
              {items.map(mission => (
                <div
                  key={mission.id}
                  onClick={() => navigate(`/missions/${mission.id}`)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-4 py-3 transition-all hover:border-zinc-700 hover:bg-zinc-800/60"
                  style={{ borderLeftWidth: "3px", borderLeftColor: cfg.color }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-zinc-100">
                      {mission.title}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-500">
                      <span className="text-zinc-400">{mission.projectId}</span>
                      <span>·</span>
                      <span>{STEP_LABELS[mission.currentStep] ?? mission.currentStep}</span>
                      {mission.createdByName && (
                        <>
                          <span>·</span>
                          <span>{mission.createdByName}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* PR badge */}
                  {mission.mrUrl && (
                    <span
                      className="flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-medium"
                      style={{
                        background: mission.mrStatus === "merged" ? "#052e16" : "#422006",
                        color: mission.mrStatus === "merged" ? "#4ade80" : "#fbbf24",
                      }}
                    >
                      <GitPullRequest className="h-2.5 w-2.5" />
                      {mission.mrStatus ?? "PR"}
                    </span>
                  )}

                  {/* Cost */}
                  {mission.totalCost > 0 && (
                    <span className="text-[11px] tabular-nums text-zinc-500">
                      {formatCost(mission.totalCost)}
                    </span>
                  )}

                  {/* Time */}
                  <span className="text-[11px] text-zinc-600">
                    {formatRelative(mission.updatedAt)}
                  </span>

                  <ChevronRight className="h-3.5 w-3.5 text-zinc-700" />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {groups.length === 0 && (
        <div className="py-20 text-center text-sm text-zinc-500">
          No missions yet
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/components/missions/MissionListView.tsx
git commit -m "feat(missions): add grouped list view component"
```

---

### Task 3: Kanban View Component

**Files:**
- Create: `components/missions/MissionKanbanView.tsx`

- [ ] **Step 1: Create MissionKanbanView.tsx**

```tsx
// components/missions/MissionKanbanView.tsx
import { useLocation } from "wouter";
import { GitPullRequest, User, Clock } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import type { MissionItem } from "../../api/types";
import {
  KANBAN_COLUMNS,
  STEP_LABELS,
  getStatusConfig,
  formatRelative,
  formatNum,
} from "./mission-constants";

interface MissionKanbanViewProps {
  missions: MissionItem[];
}

export function MissionKanbanView({ missions }: MissionKanbanViewProps) {
  const [, navigate] = useLocation();

  const columns = KANBAN_COLUMNS.map(key => {
    const cfg = getStatusConfig(key);
    return {
      ...cfg,
      items: missions.filter(m => m.status === key),
    };
  });

  const otherItems = missions.filter(
    m => !KANBAN_COLUMNS.includes(m.status as any)
  );

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        {columns.map(col => (
          <div key={col.key} className="rounded-lg border border-zinc-800 bg-zinc-900/40">
            {/* Column header */}
            <div className="flex items-center gap-2 border-b border-zinc-800/50 px-3 py-2.5">
              <span
                className="h-[7px] w-[7px] rounded-full"
                style={{ background: col.color }}
              />
              <span className="text-[12px] font-medium" style={{ color: col.color }}>
                {col.label}
              </span>
              <span className="ml-auto rounded-md bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {col.items.length}
              </span>
            </div>

            {/* Cards */}
            <ScrollArea className="max-h-[500px]">
              <div className="space-y-1.5 p-2">
                {col.items.length === 0 ? (
                  <div className="py-8 text-center text-[10px] text-zinc-600">Empty</div>
                ) : (
                  col.items.map(mission => (
                    <div
                      key={mission.id}
                      onClick={() => navigate(`/missions/${mission.id}`)}
                      className="cursor-pointer rounded-md border border-zinc-800/60 bg-zinc-900 p-3 transition-all hover:border-zinc-700 hover:bg-zinc-800/60"
                    >
                      <div className="line-clamp-2 text-[13px] font-medium text-zinc-100">
                        {mission.title}
                      </div>
                      {mission.description && (
                        <div className="mt-1 line-clamp-2 text-[11px] text-zinc-500">
                          {mission.description}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400 border border-zinc-700/50">
                          {STEP_LABELS[mission.currentStep] ?? mission.currentStep}
                        </span>
                        {mission.mrUrl && (
                          <span
                            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium"
                            style={{
                              background: mission.mrStatus === "merged" ? "#052e16" : "#422006",
                              color: mission.mrStatus === "merged" ? "#4ade80" : "#fbbf24",
                            }}
                          >
                            <GitPullRequest className="h-2.5 w-2.5" />
                            {mission.mrStatus ?? "MR"}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-[9px] text-zinc-600">
                        {mission.createdByName && (
                          <span className="flex items-center gap-0.5">
                            <User className="h-2.5 w-2.5" /> {mission.createdByName}
                          </span>
                        )}
                        {mission.totalTokens > 0 && (
                          <span>{formatNum(mission.totalTokens)} tok</span>
                        )}
                        {mission.totalCost > 0 && (
                          <span>${mission.totalCost.toFixed(2)}</span>
                        )}
                        <span className="ml-auto flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {formatRelative(mission.updatedAt)}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        ))}
      </div>

      {/* Other statuses */}
      {otherItems.length > 0 && (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="mb-2 text-[12px] font-medium text-zinc-400">
            Other ({otherItems.length})
          </div>
          <div className="space-y-1.5">
            {otherItems.map(mission => (
              <div
                key={mission.id}
                onClick={() => navigate(`/missions/${mission.id}`)}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800/60 bg-zinc-900 px-3 py-2.5 transition-all hover:border-zinc-700 hover:bg-zinc-800/60"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: getStatusConfig(mission.status).color }}
                />
                <span className="flex-1 text-[13px] font-medium text-zinc-100">{mission.title}</span>
                <span
                  className="rounded px-2 py-0.5 text-[9px] font-medium"
                  style={{
                    background: getStatusConfig(mission.status).bgColor,
                    color: getStatusConfig(mission.status).textColor,
                  }}
                >
                  {getStatusConfig(mission.status).label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/components/missions/MissionKanbanView.tsx
git commit -m "feat(missions): add restyled kanban view component"
```

---

### Task 4: Pipeline Progress Component

**Files:**
- Create: `components/missions/PipelineProgress.tsx`

- [ ] **Step 1: Create PipelineProgress.tsx**

```tsx
// components/missions/PipelineProgress.tsx
import { PIPELINE_STEPS, STEP_LABELS } from "./mission-constants";

interface PipelineProgressProps {
  currentStep: string;
}

export function PipelineProgress({ currentStep }: PipelineProgressProps) {
  const currentIndex = PIPELINE_STEPS.indexOf(currentStep as any);

  return (
    <div className="flex items-center gap-0">
      {PIPELINE_STEPS.map((step, i) => {
        const isCompleted = i < currentIndex;
        const isCurrent = i === currentIndex;
        const isFuture = i > currentIndex;

        return (
          <div key={step} className="flex items-center">
            {/* Dot */}
            <div className="flex flex-col items-center">
              <div className="relative">
                <div
                  className={`h-3 w-3 rounded-full border-2 ${
                    isCompleted
                      ? "border-emerald-500 bg-emerald-500"
                      : isCurrent
                        ? "border-amber-400 bg-amber-400/20"
                        : "border-zinc-700 bg-transparent"
                  }`}
                />
                {isCurrent && (
                  <div className="absolute inset-0 animate-ping rounded-full bg-amber-400/30" />
                )}
              </div>
              <span
                className={`mt-1.5 text-[9px] font-medium ${
                  isCompleted
                    ? "text-emerald-500"
                    : isCurrent
                      ? "text-amber-400"
                      : "text-zinc-600"
                }`}
              >
                {STEP_LABELS[step]}
              </span>
            </div>

            {/* Connector line */}
            {i < PIPELINE_STEPS.length - 1 && (
              <div
                className={`mx-1 h-[2px] w-8 sm:w-12 ${
                  i < currentIndex ? "bg-emerald-500" : "bg-zinc-800"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/components/missions/PipelineProgress.tsx
git commit -m "feat(missions): add pipeline progress bar component"
```

---

### Task 5: Mission Detail Page

**Files:**
- Create: `pages/MissionDetail.tsx`
- Modify: `App.tsx`

- [ ] **Step 1: Create MissionDetail.tsx**

```tsx
// pages/MissionDetail.tsx
import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Layout } from "../components/Layout";
import { Button } from "../components/ui/button";
import { ArrowLeft, ExternalLink, GitPullRequest, Check, X } from "lucide-react";
import * as api from "../api/client";
import type { MissionDetailItem, ChatMessage } from "../api/types";
import { PipelineProgress } from "../components/missions/PipelineProgress";
import {
  getStatusConfig,
  STEP_LABELS,
  formatRelative,
  formatCost,
  formatNum,
  formatDuration,
} from "../components/missions/mission-constants";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── Helpers ──

function parseTime(raw: string): Date {
  const n = Number(raw);
  return isNaN(n) || raw.includes("-") ? new Date(raw) : new Date(n);
}

function formatTime(raw: string): string {
  const d = parseTime(raw);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function cleanUserMessage(text: string): string {
  return text
    .replace(/^\[Replying to: "[^"]*"\]\s*/s, "")
    .replace(/^贺华杰:\s*/m, "")
    .trim();
}

// ── Main Component ──

export function MissionDetail() {
  const [, params] = useRoute("/missions/:id");
  const [, navigate] = useLocation();
  const id = params?.id ?? "";

  const [mission, setMission] = useState<MissionDetailItem | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [msgLoading, setMsgLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      try {
        const data = await api.getMissionDetail(id);
        setMission(data);
        // Load conversation if threadId exists
        if (data.chatId) {
          setMsgLoading(true);
          try {
            const msgs = await api.getConversationMessages(
              data.chatId,
              data.threadId ?? undefined
            );
            setMessages(msgs);
          } catch {}
          setMsgLoading(false);
        }
      } catch {}
      setLoading(false);
    })();
  }, [id]);

  if (loading) {
    return (
      <Layout title="Mission" subtitle="Loading...">
        <div className="py-20 text-center text-sm text-zinc-500 animate-pulse">
          Loading mission...
        </div>
      </Layout>
    );
  }

  if (!mission) {
    return (
      <Layout title="Mission" subtitle="Not Found">
        <div className="py-20 text-center">
          <div className="text-sm text-zinc-500">Mission not found</div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-4"
            onClick={() => navigate("/missions")}
          >
            <ArrowLeft className="mr-1 h-3 w-3" /> Back to Missions
          </Button>
        </div>
      </Layout>
    );
  }

  const statusCfg = getStatusConfig(mission.status);

  return (
    <Layout title="Mission" subtitle={mission.title}>
      {/* Back button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate("/missions")}
        className="mb-4 h-7 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <ArrowLeft className="mr-1 h-3 w-3" /> Missions
      </Button>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* ── Left Column (main content) ── */}
        <div className="min-w-0 flex-1 space-y-6">
          {/* Title + description */}
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">{mission.title}</h2>
            {mission.description && (
              <p className="mt-2 text-sm text-zinc-400">{mission.description}</p>
            )}
          </div>

          {/* Pipeline progress */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Pipeline
            </div>
            <PipelineProgress currentStep={mission.currentStep} />
          </div>

          {/* Conversation flow */}
          <div>
            <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Conversation
            </div>
            {msgLoading ? (
              <div className="py-10 text-center text-sm text-zinc-600 animate-pulse">
                Loading messages...
              </div>
            ) : messages.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 py-10 text-center text-sm text-zinc-600">
                No conversation found
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map(msg => {
                  const isBot = msg.senderType === "app";
                  const content = isBot ? msg.content : cleanUserMessage(msg.content ?? "");
                  if (!content) return null;

                  return (
                    <div
                      key={msg.id}
                      className={`flex ${isBot ? "justify-start" : "justify-end"}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-lg px-4 py-2.5 text-sm ${
                          isBot
                            ? "border border-zinc-800 bg-zinc-900/60 text-zinc-200"
                            : "bg-zinc-800 text-zinc-200"
                        }`}
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <span className="text-[10px] font-medium text-zinc-500">
                            {isBot ? "Remi" : "Jack"}
                          </span>
                          <span className="text-[10px] text-zinc-600">
                            {formatTime(msg.createTime)}
                          </span>
                        </div>
                        <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-pre:my-1">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Right Column (sidebar) ── */}
        <div className="w-full space-y-4 lg:w-72 lg:flex-shrink-0">
          {/* Status */}
          <SidebarSection label="Status">
            <span
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium"
              style={{ background: statusCfg.bgColor, color: statusCfg.textColor }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: statusCfg.color }}
              />
              {statusCfg.label}
            </span>
          </SidebarSection>

          {/* Step */}
          <SidebarSection label="Current Step">
            <span className="text-sm text-zinc-300">
              {STEP_LABELS[mission.currentStep] ?? mission.currentStep}
            </span>
          </SidebarSection>

          {/* Project */}
          <SidebarSection label="Project">
            <span className="text-sm text-zinc-300">{mission.projectId}</span>
          </SidebarSection>

          {/* Created by */}
          {mission.createdByName && (
            <SidebarSection label="Created by">
              <span className="text-sm text-zinc-300">{mission.createdByName}</span>
            </SidebarSection>
          )}

          {/* MR Link */}
          {mission.mrUrl && (
            <SidebarSection label="Pull Request">
              <a
                href={mission.mrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300"
              >
                <GitPullRequest className="h-3.5 w-3.5" />
                {mission.mrStatus ?? "PR"}
                <ExternalLink className="h-3 w-3" />
              </a>
            </SidebarSection>
          )}

          {/* Stats */}
          <SidebarSection label="Stats">
            <div className="space-y-1.5 text-sm">
              {mission.totalTokens > 0 && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">Tokens</span>
                  <span className="tabular-nums text-zinc-300">
                    {formatNum(mission.totalTokens)}
                  </span>
                </div>
              )}
              {mission.totalCost > 0 && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">Cost</span>
                  <span className="tabular-nums text-zinc-300">
                    {formatCost(mission.totalCost)}
                  </span>
                </div>
              )}
              {mission.totalDuration > 0 && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">Duration</span>
                  <span className="tabular-nums text-zinc-300">
                    {formatDuration(mission.totalDuration)}
                  </span>
                </div>
              )}
            </div>
          </SidebarSection>

          {/* Contract */}
          {mission.contract && (
            <SidebarSection label="Contract">
              {mission.contract.acceptanceCriteria.length > 0 && (
                <div className="space-y-1">
                  {mission.contract.acceptanceCriteria.map((c, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[11px] text-zinc-400">
                      <span className="mt-0.5 text-zinc-600">•</span>
                      {c}
                    </div>
                  ))}
                </div>
              )}
              {mission.contract.verificationResults && (
                <div className="mt-2 space-y-1">
                  {mission.contract.verificationResults.caseResults.map(cr => (
                    <div
                      key={cr.caseId}
                      className="flex items-center gap-1.5 text-[11px]"
                    >
                      {cr.passed ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <X className="h-3 w-3 text-red-400" />
                      )}
                      <span className={cr.passed ? "text-zinc-400" : "text-red-400"}>
                        {cr.detail.slice(0, 60)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </SidebarSection>
          )}

          {/* Timestamps */}
          <SidebarSection label="Timestamps">
            <div className="space-y-1 text-[11px]">
              <div className="flex justify-between">
                <span className="text-zinc-600">Created</span>
                <span className="text-zinc-400">{formatRelative(mission.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-600">Updated</span>
                <span className="text-zinc-400">{formatRelative(mission.updatedAt)}</span>
              </div>
              {mission.completedAt && (
                <div className="flex justify-between">
                  <span className="text-zinc-600">Completed</span>
                  <span className="text-zinc-400">{formatRelative(mission.completedAt)}</span>
                </div>
              )}
            </div>
          </SidebarSection>
        </div>
      </div>
    </Layout>
  );
}

// ── Sidebar Section Helper ──

function SidebarSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-zinc-600">
        {label}
      </div>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

In `App.tsx`, add the import at the top and the route inside `<Switch>`:

Import (add after line 3):
```typescript
import { MissionDetail } from "./pages/MissionDetail";
```

Route (add after the `/missions` route, around line 42):
```tsx
<Route path="/missions/:id" component={MissionDetail} />
```

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/pages/MissionDetail.tsx web/frontend/src/App.tsx
git commit -m "feat(missions): add detail page with pipeline progress and conversation flow"
```

---

### Task 6: Rewrite Missions Page Shell

**Files:**
- Rewrite: `pages/Missions.tsx`

- [ ] **Step 1: Rewrite Missions.tsx**

Replace the entire file with:

```tsx
// pages/Missions.tsx
import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { KanbanSquare, List } from "lucide-react";
import * as api from "../api/client";
import type { MissionItem } from "../api/types";
import { MissionListView } from "../components/missions/MissionListView";
import { MissionKanbanView } from "../components/missions/MissionKanbanView";

type ViewMode = "list" | "kanban";

export function Missions() {
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>("list");

  useEffect(() => {
    fetchMissions();
  }, []);

  const fetchMissions = async () => {
    setLoading(true);
    try {
      const data = await api.getMissions();
      setMissions(data);
    } catch {}
    setLoading(false);
  };

  return (
    <Layout title="Missions" subtitle="Project Board">
      {/* View toggle */}
      <div className="mb-5 flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1 w-fit">
        <button
          onClick={() => setView("list")}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-all ${
            view === "list"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <List className="h-3.5 w-3.5" />
          List
        </button>
        <button
          onClick={() => setView("kanban")}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-all ${
            view === "kanban"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <KanbanSquare className="h-3.5 w-3.5" />
          Kanban
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="py-20 text-center text-sm text-zinc-500 animate-pulse">
          Loading...
        </div>
      ) : view === "list" ? (
        <MissionListView missions={missions} />
      ) : (
        <MissionKanbanView missions={missions} />
      )}
    </Layout>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run:
```bash
cd web/frontend && npx tsc --noEmit 2>&1 | head -30
```

Expected: No type errors (or only pre-existing ones unrelated to missions).

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/pages/Missions.tsx
git commit -m "feat(missions): rewrite page shell with list/kanban toggle"
```

---

### Task 7: Clean Up Mock File & Final Verification

**Files:**
- Delete: `web/frontend/public/mock-missions.html`

- [ ] **Step 1: Remove mock file**

```bash
rm web/frontend/public/mock-missions.html
```

- [ ] **Step 2: Build the frontend to verify everything compiles**

```bash
cd web/frontend && npm run build 2>&1 | tail -10
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Manually verify in browser**

Open `http://10.37.66.8:5199/#/missions` and verify:
1. List view renders with grouped-by-status layout
2. Toggle to Kanban works
3. Click a mission card navigates to `/missions/:id`
4. Detail page shows pipeline progress + conversation flow
5. Back button returns to list

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(missions): remove mock file, finalize mission module redesign"
```
