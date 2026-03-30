/**
 * Shared Mission Detail content — used by both Dashboard and Board.
 * Callers provide the mission ID; this component handles data fetching and rendering.
 */

import { useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  GitPullRequest,
  Check,
  X,
  FileText,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import * as api from "../../api/client";
import type { MissionDetailItem, ChatMessage } from "../../api/types";
import { PipelineProgress } from "./PipelineProgress";
import {
  getStatusConfig,
  STEP_LABELS,
  PIPELINE_STEPS,
  formatRelative,
  formatCost,
  formatNum,
  formatDuration,
} from "./mission-constants";
import { ConversationView } from "../ConversationView";

/** Map pipeline steps to their known output file names */
const STEP_OUTPUT_FILES: Record<string, { file: string; label: string }> = {
  intake: { file: "description.md", label: "Requirements" },
  rfc: { file: "RFC.md", label: "Technical RFC" },
  decompose: { file: "tasks.md", label: "Task Breakdown" },
  eval: { file: "eval-report.md", label: "Evaluation Report" },
  summary: { file: "summary.md", label: "Summary" },
};

interface MissionDetailContentProps {
  id: string;
  onBack?: () => void;
  backLabel?: string;
}

export function MissionDetailContent({ id, onBack, backLabel = "Back" }: MissionDetailContentProps) {
  const [mission, setMission] = useState<MissionDetailItem | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [msgLoading, setMsgLoading] = useState(false);
  const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set());
  const conversationBottomRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (messages.length > 0) {
      conversationBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  if (loading) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground animate-pulse">
        Loading mission...
      </div>
    );
  }

  if (!mission) {
    return (
      <div className="py-20 text-center">
        <div className="text-sm text-muted-foreground">Mission not found</div>
        {onBack && (
          <button
            className="mt-4 text-xs text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            &larr; {backLabel}
          </button>
        )}
      </div>
    );
  }

  const statusCfg = getStatusConfig(mission.status);
  const currentStepIdx = PIPELINE_STEPS.indexOf(mission.currentStep as any);

  const toggleCase = (caseId: string) => {
    setExpandedCases(prev => {
      const next = new Set(prev);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });
  };

  return (
    <>
      {onBack && (
        <button
          className="mb-4 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          &larr; {backLabel}
        </button>
      )}

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left Column */}
        <div className="min-w-0 flex-1 space-y-6">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold text-foreground">{mission.title}</h2>
              <span className="text-xs text-zinc-500 font-mono">{mission.id}</span>
            </div>
            {mission.description && (
              <p className="mt-2 text-sm text-muted-foreground">{mission.description}</p>
            )}
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Pipeline
            </div>
            <PipelineProgress currentStep={mission.currentStep} />
          </div>

          {/* Contract Cases */}
          {mission.contract?.cases && mission.contract.cases.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Contract Cases
              </div>
              <div className="space-y-2">
                {mission.contract.cases.map((c, i) => {
                  const expanded = expandedCases.has(c.id);
                  const result = mission.contract?.verificationResults?.caseResults?.find(
                    r => r.caseId === c.id
                  );
                  return (
                    <div key={c.id} className="rounded-md border border-border bg-background p-3">
                      <div
                        className="flex cursor-pointer items-center gap-2"
                        onClick={() => toggleCase(c.id)}
                      >
                        {expanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        )}
                        <span className="text-[11px] font-mono text-muted-foreground">
                          #{i + 1}
                        </span>
                        {result && (
                          result.passed ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <X className="h-3 w-3 text-red-400" />
                          )
                        )}
                        <span className="flex-1 text-[12px] text-foreground">
                          {c.description}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                          {c.type}
                        </span>
                      </div>
                      {expanded && (
                        <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
                          <div>
                            <div className="text-[10px] font-medium text-muted-foreground">Input</div>
                            <pre className="mt-1 rounded bg-muted/50 p-2 text-[11px] text-foreground whitespace-pre-wrap">
                              {c.input}
                            </pre>
                          </div>
                          <div>
                            <div className="text-[10px] font-medium text-muted-foreground">Expected Output</div>
                            <pre className="mt-1 rounded bg-muted/50 p-2 text-[11px] text-foreground whitespace-pre-wrap">
                              {c.expectedOutput}
                            </pre>
                          </div>
                          {result && (
                            <div>
                              <div className="text-[10px] font-medium text-muted-foreground">Result</div>
                              <p className={`mt-1 text-[11px] ${result.passed ? "text-emerald-400" : "text-red-400"}`}>
                                {result.detail}
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Output Files */}
          {mission.outputDir && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Output Files
              </div>
              <p className="mb-3 text-[10px] font-mono text-muted-foreground/60 break-all">
                {mission.outputDir}
              </p>
              <div className="space-y-1">
                {Object.entries(STEP_OUTPUT_FILES).map(([step, { file, label }]) => {
                  const stepIdx = PIPELINE_STEPS.indexOf(step as any);
                  const completed = stepIdx >= 0 && stepIdx <= currentStepIdx;
                  return (
                    <div
                      key={step}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5"
                    >
                      {completed ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <FileText className="h-3 w-3 text-muted-foreground/40" />
                      )}
                      <span className={`text-[12px] ${completed ? "text-foreground" : "text-muted-foreground/50"}`}>
                        {label}
                      </span>
                      <span className={`ml-auto font-mono text-[10px] ${completed ? "text-muted-foreground" : "text-muted-foreground/30"}`}>
                        {file}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="max-w-4xl mx-auto">
            <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Conversation
            </div>
            <ConversationView
              messages={messages}
              msgLoading={msgLoading}
              bottomRef={conversationBottomRef}
            />
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
            <span className="text-sm text-foreground">
              {STEP_LABELS[mission.currentStep] ?? mission.currentStep}
            </span>
          </SidebarSection>

          <SidebarSection label="Project">
            <span className="text-sm text-foreground">{mission.projectId}</span>
          </SidebarSection>

          {mission.createdByName && (
            <SidebarSection label="Created by">
              <span className="text-sm text-foreground">{mission.createdByName}</span>
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
                  <span className="text-muted-foreground">Tokens</span>
                  <span className="tabular-nums text-foreground">
                    {formatNum(mission.totalTokens)}
                  </span>
                </div>
              )}
              {mission.totalCost > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cost</span>
                  <span className="tabular-nums text-foreground">
                    {formatCost(mission.totalCost)}
                  </span>
                </div>
              )}
              {mission.totalDuration > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration</span>
                  <span className="tabular-nums text-foreground">
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
                    <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <span className="mt-0.5 text-muted-foreground">&bull;</span>
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
                      <span className={cr.passed ? "text-muted-foreground" : "text-red-400"}>
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
                <span className="text-muted-foreground">Created</span>
                <span className="text-muted-foreground">{formatRelative(mission.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Updated</span>
                <span className="text-muted-foreground">{formatRelative(mission.updatedAt)}</span>
              </div>
              {mission.completedAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Completed</span>
                  <span className="text-muted-foreground">{formatRelative(mission.completedAt)}</span>
                </div>
              )}
            </div>
          </SidebarSection>
        </div>
      </div>
    </>
  );
}

function SidebarSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
