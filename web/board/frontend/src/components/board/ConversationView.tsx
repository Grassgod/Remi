import { useEffect, useState } from "react";
import type { ChatMessage, Mission } from "../../api";
import * as api from "../../api";

interface Props {
  mission: Mission;
  onClose: () => void;
}

function formatTime(unixMs: string): string {
  const d = new Date(parseInt(unixMs));
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(unixMs: string): string {
  const d = new Date(parseInt(unixMs));
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

const STATUS_INFO: Record<string, { label: string; color: string }> = {
  inbox: { label: "Inbox", color: "#e2e2e5" },
  in_progress: { label: "In Progress", color: "#f2994a" },
  in_review: { label: "In Review", color: "#eb5757" },
  done: { label: "Done", color: "#10a37f" },
  rejected: { label: "Rejected", color: "#999" },
  blocked: { label: "Blocked", color: "#eb5757" },
};

export function ConversationView({ mission, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.fetchMessages(mission.id)
      .then(setMessages)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mission.id]);

  const statusInfo = STATUS_INFO[mission.status] ?? { label: mission.status, color: "#999" };

  return (
    <div className="flex h-full flex-col border-l border-border bg-white">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 min-h-[52px]">
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors text-[0.88rem]"
        >
          ←
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-[0.9rem] font-semibold text-foreground truncate">
            {mission.title}
          </h2>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[0.72rem] font-mono text-muted-foreground">
              {mission.id.slice(0, 11).toUpperCase()}
            </span>
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.68rem] font-semibold"
              style={{ backgroundColor: statusInfo.color + "18", color: statusInfo.color }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: statusInfo.color }}
              />
              {statusInfo.label}
            </span>
          </div>
        </div>
      </div>

      {/* Meta bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border text-[0.76rem] text-muted-foreground">
        {mission.createdByName && <span>by {mission.createdByName}</span>}
        <span>{mission.currentStep}</span>
        {mission.totalTokens > 0 && (
          <span className="font-mono">{(mission.totalTokens / 1000).toFixed(0)}k tokens</span>
        )}
        {mission.mrUrl && (
          <a href={mission.mrUrl} target="_blank" rel="noopener" className="text-primary hover:underline">
            MR {mission.mrStatus === "merged" ? "merged" : "open"}
          </a>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[0.82rem] text-muted-foreground animate-pulse">
            Loading conversation...
          </div>
        ) : error ? (
          <div className="p-4 text-[0.82rem] text-destructive">{error}</div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[0.82rem] text-muted-foreground/40">
            No messages yet
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const TOOL_SVGS: Record<string, JSX.Element> = {
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
  if (svg) {
    return <span className={`inline-block w-3.5 h-3.5 text-muted-foreground/50 ${className ?? ""}`}>{svg}</span>;
  }
  return (
    <span className={`inline-block w-3.5 h-3.5 text-muted-foreground/50 ${className ?? ""}`}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="8" cy="8" r="2.5"/>
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4"/>
      </svg>
    </span>
  );
}

function ThinkingIcon({ className }: { className?: string }) {
  return (
    <span className={`inline-block w-3.5 h-3.5 text-muted-foreground/50 ${className ?? ""}`}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        <rect x="3" y="5" width="10" height="8" rx="2"/>
        <circle cx="6" cy="9" r="1"/>
        <circle cx="10" cy="9" r="1"/>
        <line x1="8" y1="2" x2="8" y2="5"/>
        <circle cx="8" cy="1.5" r="1"/>
      </svg>
    </span>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const [showSteps, setShowSteps] = useState(false);
  const isBot = message.senderType === "app";
  const time = formatTime(message.createTime);
  const date = formatDate(message.createTime);
  const totalSteps = message.steps?.length ?? 0;
  const toolCount = message.meta?.toolCount ?? message.steps?.filter(s => s.type === "tool").length ?? 0;

  return (
    <div className={`px-4 py-3 ${isBot ? "bg-[#fafafa]" : "bg-white"}`}>
      {/* Sender + time */}
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[0.6rem] font-bold text-white ${
          isBot ? "bg-primary" : "bg-[#6e6e80]"
        }`}>
          {isBot ? "R" : "U"}
        </div>
        <span className="text-[0.78rem] font-semibold text-foreground">
          {isBot ? "Remi" : "User"}
        </span>
        <span className="text-[0.7rem] text-muted-foreground/50">
          {date} {time}
        </span>
      </div>

      {/* Collapsible steps panel — thinking + tool_use */}
      {isBot && totalSteps > 0 && (
        <div className="ml-7 mb-1.5">
          <button
            onClick={() => setShowSteps(!showSteps)}
            className="text-[0.7rem] text-muted-foreground/50 hover:text-muted-foreground transition-colors flex items-center gap-1"
          >
            <span className="text-[0.65rem]">{showSteps ? "▾" : "▸"}</span>
            {totalSteps} steps
          </button>
          {showSteps && (
            <div className="mt-1 mb-1 space-y-0.5 max-h-[300px] overflow-auto">
              {message.steps!.map((step, i) => (
                <div key={i} className="py-0.5">
                  {step.type === "thinking" ? (
                    <div className="flex gap-1.5 text-[0.7rem] text-muted-foreground/50">
                      <ThinkingIcon className="flex-shrink-0 mt-0.5" />
                      <span className="whitespace-pre-wrap">{step.content}</span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1.5 text-[0.7rem] text-muted-foreground/60">
                      <ToolIcon name={step.name ?? ""} className="flex-shrink-0 mt-0.5" />
                      <div>
                        <span className="font-mono font-medium">{step.name}</span>
                        {step.content && <span className="text-muted-foreground/40 ml-1.5 break-all">{step.content}</span>}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content */}
      {message.type === "card" ? (
        <div className="ml-7">
          <div className="rounded-lg border border-border bg-white p-3 text-[0.82rem] text-muted-foreground italic">
            Remi responded with an interactive card
          </div>
          {/* Stats from conversation metadata */}
          {message.meta && (
            <div className="mt-1.5 flex items-center gap-3 text-[0.7rem] text-muted-foreground/60 font-mono">
              <span>{message.meta.model?.split("[")[0]}</span>
              <span>{message.meta.inputTokens + message.meta.outputTokens} tokens</span>
              <span>{(message.meta.duration / 1000).toFixed(1)}s</span>
              {toolCount > 0 && <span>⚙ {toolCount} tools</span>}
            </div>
          )}
        </div>
      ) : (
        <div className="ml-7 text-[0.84rem] text-foreground leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      )}
    </div>
  );
}
