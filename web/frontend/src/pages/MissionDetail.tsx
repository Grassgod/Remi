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
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate("/missions")}
        className="mb-4 h-7 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <ArrowLeft className="mr-1 h-3 w-3" /> Missions
      </Button>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left Column */}
        <div className="min-w-0 flex-1 space-y-6">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">{mission.title}</h2>
            {mission.description && (
              <p className="mt-2 text-sm text-zinc-400">{mission.description}</p>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Pipeline
            </div>
            <PipelineProgress currentStep={mission.currentStep} />
          </div>

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

        {/* Right Column (sidebar) */}
        <div className="w-full space-y-4 lg:w-72 lg:flex-shrink-0">
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

          <SidebarSection label="Current Step">
            <span className="text-sm text-zinc-300">
              {STEP_LABELS[mission.currentStep] ?? mission.currentStep}
            </span>
          </SidebarSection>

          <SidebarSection label="Project">
            <span className="text-sm text-zinc-300">{mission.projectId}</span>
          </SidebarSection>

          {mission.createdByName && (
            <SidebarSection label="Created by">
              <span className="text-sm text-zinc-300">{mission.createdByName}</span>
            </SidebarSection>
          )}

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
