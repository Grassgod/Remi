import { useState } from "react";
import type { RefObject } from "react";
import type { ChatMessage } from "../api/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Activity } from "lucide-react";
import { cn } from "~remiadmin/lib/utils";

// ── Time Helpers ──────────────────────────────────────

function parseTime(raw: string): Date {
  const n = Number(raw);
  return isNaN(n) || raw.includes("-") ? new Date(raw) : new Date(n);
}

function formatTime(raw: string): string {
  const d = parseTime(raw);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(raw: string): string {
  const d = parseTime(raw);
  if (isNaN(d.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function cleanUserMessage(text: string): string {
  return text
    .replace(/^\[Replying to: "[^"]*"\]\s*/s, "")
    .replace(/^贺华杰:\s*/m, "")
    .replace(/^ou_[a-f0-9]+:\s*/m, "")
    .trim();
}

// ── Tool Icons ────────────────────────────────────────

const TOOL_SVGS: Record<string, React.ReactElement> = {
  Bash: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M5 7l2 1.5L5 10"/><line x1="9" y1="10" x2="12" y2="10"/></svg>,
  Write: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M9.5 4.5l2 2"/></svg>,
  Edit: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M9.5 4.5l2 2"/></svg>,
  Read: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M9 2v4h4"/></svg>,
  Glob: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>,
  Grep: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>,
  WebSearch: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>,
  WebFetch: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="3" ry="6"/><line x1="2" y1="8" x2="14" y2="8"/></svg>,
  Agent: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="3" y="5" width="10" height="8" rx="2"/><circle cx="6" cy="9" r="1"/><circle cx="10" cy="9" r="1"/><line x1="8" y1="2" x2="8" y2="5"/><circle cx="8" cy="1.5" r="1"/></svg>,
  Skill: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3 4l2 2 3-3"/><line x1="10" y1="5" x2="14" y2="5"/><path d="M3 9l2 2 3-3"/><line x1="10" y1="10" x2="14" y2="10"/></svg>,
  TodoWrite: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3 4l2 2 3-3"/><line x1="10" y1="5" x2="14" y2="5"/><path d="M3 9l2 2 3-3"/><line x1="10" y1="10" x2="14" y2="10"/></svg>,
};

function ToolIcon({ name, className }: { name: string; className?: string }) {
  const svg = TOOL_SVGS[name];
  if (svg) return <span className={cn("inline-block w-3.5 h-3.5 text-muted-foreground", className)}>{svg}</span>;
  return (
    <span className={cn("inline-block w-3.5 h-3.5 text-muted-foreground", className)}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4"/>
      </svg>
    </span>
  );
}

function ThinkingIcon({ className }: { className?: string }) {
  return (
    <span className={cn("inline-block w-3.5 h-3.5 text-muted-foreground", className)}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        <rect x="3" y="5" width="10" height="8" rx="2"/><circle cx="6" cy="9" r="1"/><circle cx="10" cy="9" r="1"/><line x1="8" y1="2" x2="8" y2="5"/><circle cx="8" cy="1.5" r="1"/>
      </svg>
    </span>
  );
}

// ── Remi Card ─────────────────────────────────────────

function RemiCard({ message, date, time }: { message: ChatMessage; date: string; time: string }) {
  const [showSteps, setShowSteps] = useState(false);
  const meta = message.meta;
  const steps = message.steps ?? [];
  const toolSteps = steps.filter(s => s.type === "tool");
  const toolCount = meta?.toolCount ?? toolSteps.length;
  const sessionName = message.sessionName ?? "Remi";

  return (
    <div className="max-w-[90%] rounded-lg border border-border/40 dark:border-white/10 bg-card shadow-sm overflow-hidden">
      {/* Card header — session name */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30 dark:border-white/5 bg-muted/30">
        <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
          R
        </div>
        <span className="text-xs font-semibold text-foreground/80">{sessionName}</span>
        <span className="text-[11px] text-muted-foreground/60">{date} {time}</span>
      </div>

      {/* Collapsible steps panel */}
      {steps.length > 0 && (
        <div className="px-4 pt-2">
          <button
            onClick={() => setShowSteps(!showSteps)}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            <span className="text-[10px]">{showSteps ? "▾" : "▸"}</span>
            Show {toolCount} steps
          </button>
          {showSteps && (
            <div className="mt-1 mb-2 space-y-0.5 max-h-[300px] overflow-auto">
              {steps.map((step, i) => (
                <div key={i} className="py-0.5">
                  {step.type === "thinking" ? (
                    <div className="flex gap-1.5 text-[11px] text-muted-foreground/70">
                      <ThinkingIcon className="flex-shrink-0 mt-0.5" />
                      <span className="whitespace-pre-wrap">{step.content}</span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <ToolIcon name={step.name ?? ""} className="flex-shrink-0 mt-0.5" />
                      <div>
                        <span className="font-mono font-medium">{step.name}</span>
                        {step.content && <span className="text-muted-foreground/60 ml-1.5 break-all">{step.content}</span>}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content body */}
      <div className="px-4 py-3">
        {message.content ? (
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground/50 italic">No text content</div>
        )}
      </div>

      {/* Stats footer */}
      {meta && (
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border/30 dark:border-white/5 text-[11px] text-muted-foreground">
          {meta.duration != null && meta.duration > 0 && (
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>
              </svg>
              <span className="font-mono">{(meta.duration / 1000).toFixed(1)}s</span>
            </span>
          )}
          {(meta.inputTokens != null || meta.outputTokens != null) && (
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M2 4h5l2 2H14v7H2z"/><path d="M2 4V2h12v4"/>
              </svg>
              <span className="font-mono">{meta.inputTokens ?? 0}&rarr;{meta.outputTokens ?? 0}</span>
            </span>
          )}
          {toolCount > 0 && (
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4"/>
              </svg>
              <span className="font-mono">{toolCount} tools</span>
            </span>
          )}
          {meta.cost != null && meta.cost > 0 && (
            <span className="font-mono">${meta.cost.toFixed(3)}</span>
          )}
          {meta.model && (
            <span className="font-mono text-muted-foreground/50">{meta.model.replace("claude-", "").replace(/-2025.*/, "")}</span>
          )}
          {meta.traceId && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                sessionStorage.setItem("trace-highlight", String(meta.traceId));
                window.location.hash = "#/traces";
              }}
              className="ml-auto flex items-center gap-1 cursor-pointer text-muted-foreground/50 hover:text-foreground transition-colors"
              title={`View Trace #${meta.traceId}`}
            >
              <Activity className="w-3 h-3" />
              <span className="font-mono">#{meta.traceId}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── ConversationView ──────────────────────────────────

interface ConversationViewProps {
  messages: ChatMessage[];
  msgLoading: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
  /** Display name for the user side. Defaults to "Jack". */
  userName?: string;
}

export function ConversationView({
  messages,
  msgLoading,
  bottomRef,
  userName = "Jack",
}: ConversationViewProps) {
  if (msgLoading) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">
        Loading messages...
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card py-10 text-center text-sm text-muted-foreground">
        No conversation found
      </div>
    );
  }

  return (
    <div className="max-h-[60vh] overflow-y-auto space-y-3 pr-1">
      {messages.map(msg => {
        const isBot = msg.senderType === "app";

        if (isBot) {
          const time = formatTime(msg.createTime);
          const date = formatDate(msg.createTime);
          return <RemiCard key={msg.id} message={msg} date={date} time={time} />;
        }

        // User message — right aligned
        const cleaned = cleanUserMessage(msg.content ?? "");
        if (!cleaned) return null;

        const time = formatTime(msg.createTime);
        const date = formatDate(msg.createTime);

        return (
          <div key={msg.id} className="flex flex-col items-end">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] text-muted-foreground/60">{date} {time}</span>
              <span className="text-xs font-medium text-muted-foreground font-mono">
                {!msg.senderId ? userName : msg.senderId}
              </span>
            </div>
            <div className="max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-accent">
              <div className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>
              </div>
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
