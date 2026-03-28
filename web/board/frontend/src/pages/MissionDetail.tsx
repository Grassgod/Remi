import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as api from "../api";
import type { Mission, ChatMessage } from "../api";

interface Props {
  id: string;
  onBack: () => void;
}

function parseTime(raw: string): Date {
  // Handle both ISO string and unix ms
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

/** Clean user message: remove [Replying to: "..."] prefix */
function cleanUserMessage(text: string): string {
  return text
    .replace(/^\[Replying to: "[^"]*"\]\s*/s, "")
    .trim();
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  inbox: { label: "Inbox", color: "#bbb" },
  in_progress: { label: "In Progress", color: "#f2994a" },
  in_review: { label: "In Review", color: "#eb5757" },
  done: { label: "Done", color: "#10a37f" },
  rejected: { label: "Rejected", color: "#999" },
  blocked: { label: "Blocked", color: "#eb5757" },
};

export function MissionDetail({ id, onBack }: Props) {
  const [mission, setMission] = useState<Mission | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.fetchMission(id).then(setMission).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!mission) return;
    setLoadingMsgs(true);
    setMsgError(null);
    api.fetchMessages(id)
      .then((msgs) => {
        setMessages(msgs);
        // Scroll to bottom after messages render
        setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "instant" }), 100);
      })
      .catch((e) => setMsgError(e.message))
      .finally(() => setLoadingMsgs(false));
  }, [mission?.id]);

  if (!mission) {
    return (
      <div className="flex h-dvh items-center justify-center bg-white">
        <div className="text-sm text-gray-400 animate-pulse">Loading...</div>
      </div>
    );
  }

  const statusInfo = STATUS_MAP[mission.status] ?? { label: mission.status, color: "#999" };
  // Use CLI session ID if available, otherwise mission ID
  // Show session ID if available from first Remi message, otherwise mission ID
  const firstRemiMsg = messages.find(m => m.meta?.sessionId);
  const displayId = firstRemiMsg?.meta?.sessionId ?? mission.id;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-white">
      {/* Header bar */}
      <div className="flex justify-between flex-shrink-0 pr-6 border-b border-gray-200 h-14 pl-5 items-center">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-gray-600 transition-colors text-sm">
            ← Back
          </button>
          <span className="text-gray-300">|</span>
          <span className="text-xs font-mono text-gray-400">
            {displayId}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ backgroundColor: statusInfo.color + "18", color: statusInfo.color }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusInfo.color }} />
            {statusInfo.label}
          </span>
        </div>
      </div>

      {/* Body — two column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Main content — chat area */}
        <div className="flex-[3_0_0] flex flex-col border-r border-gray-100 min-w-0 overflow-auto">
          {/* Title section */}
          <div className="px-6 pt-5 pb-3 border-b border-gray-100">
            <h1 className="text-lg font-semibold text-gray-800 mb-1">
              {mission.title}
            </h1>
            {mission.description && (
              <p className="text-sm text-gray-500 leading-relaxed whitespace-pre-wrap">
                {mission.description}
              </p>
            )}
          </div>

          {/* Conversation — Happy style left/right layout */}
          <div className="flex-1 overflow-auto px-4 py-4">
            <div className="max-w-[800px] mx-auto">
              {loadingMsgs ? (
                <div className="text-sm text-gray-400 animate-pulse py-12 text-center">
                  Loading messages...
                </div>
              ) : msgError ? (
                <div className="text-sm text-red-500 py-4 text-center">{msgError}</div>
              ) : messages.length === 0 ? (
                <div className="text-sm text-gray-300 py-12 text-center">
                  No messages yet
                </div>
              ) : (
                <div className="space-y-4">
                  {messages.map((msg) => (
                    <MessageBubble key={msg.id} message={msg} />
                  ))}
                  <div ref={chatEndRef} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="flex-[1_0_0] min-w-[240px] max-w-[300px] p-5 overflow-auto bg-gray-50/50">
          <SidebarField label="Status">
            <span className="text-sm text-gray-700">{statusInfo.label}</span>
          </SidebarField>

          <SidebarField label="Step">
            <span className="text-sm text-gray-700 font-mono">{mission.currentStep}</span>
          </SidebarField>

          <SidebarField label="Created by">
            <span className="text-sm text-gray-500 font-mono text-xs">
              {mission.createdBy ?? "—"}
            </span>
          </SidebarField>

          <SidebarField label="Created">
            <span className="text-sm text-gray-700">{new Date(mission.createdAt).toLocaleDateString()}</span>
          </SidebarField>

          {mission.mrUrl && (
            <SidebarField label="MR">
              <a href={mission.mrUrl} target="_blank" rel="noopener" className="text-sm text-blue-500 hover:underline">
                {mission.mrStatus ?? "open"}
              </a>
            </SidebarField>
          )}

          <SidebarField label="Tokens">
            <span className="text-sm text-gray-700 font-mono">
              {(() => {
                const total = messages.filter(m => m.meta).reduce((s, m) => s + (m.meta?.outputTokens ?? 0), 0);
                return total > 0 ? total.toLocaleString() : mission.totalTokens.toLocaleString();
              })()}
            </span>
          </SidebarField>

          <SidebarField label="Rounds">
            <span className="text-sm text-gray-700 font-mono">{messages.filter(m => m.senderType === "user").length}</span>
          </SidebarField>
        </div>
      </div>
    </div>
  );
}

function SidebarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1">{label}</div>
      {children}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isBot = message.senderType === "app";
  const time = formatTime(message.createTime);
  const date = formatDate(message.createTime);
  const senderLabel = isBot ? "Remi" : message.senderId?.slice(0, 12) ?? "User";

  if (isBot) {
    // ── Agent message: Card style (like Feishu card) ──
    return <RemiCard message={message} date={date} time={time} />;
  }

  // ── User message: RIGHT aligned, with bubble ──
  const cleaned = cleanUserMessage(message.content ?? "");
  if (!cleaned) return null; // skip empty after cleaning

  return (
    <div className="flex flex-col items-end">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] text-gray-300">{date} {time}</span>
        <span className="text-xs font-medium text-gray-500 font-mono">{senderLabel}</span>
      </div>
      <div className="max-w-[85%] rounded-xl px-4 py-2.5 text-sm text-gray-800 leading-relaxed"
        style={{ backgroundColor: "#f0eee6" }}
      >
        <div className="prose prose-sm max-w-none">
          <Markdown remarkPlugins={[remarkGfm]}>{cleaned}</Markdown>
        </div>
      </div>
    </div>
  );
}

/** SVG icons matching Feishu standard_icon tokens */
const TOOL_SVGS: Record<string, JSX.Element> = {
  // computer_outlined — Bash
  Bash: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M5 7l2 1.5L5 10"/><line x1="9" y1="10" x2="12" y2="10"/></svg>,
  // edit_outlined — Write/Edit
  Write: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M9.5 4.5l2 2"/></svg>,
  Edit: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M9.5 4.5l2 2"/></svg>,
  // file_outlined — Read
  Read: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M9 2v4h4"/></svg>,
  // search_outlined — Glob/Grep/WebSearch
  Glob: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>,
  Grep: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>,
  WebSearch: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>,
  // language_outlined — WebFetch
  WebFetch: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="3" ry="6"/><line x1="2" y1="8" x2="14" y2="8"/></svg>,
  // robot_outlined — Agent/thinking
  Agent: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="3" y="5" width="10" height="8" rx="2"/><circle cx="6" cy="9" r="1"/><circle cx="10" cy="9" r="1"/><line x1="8" y1="2" x2="8" y2="5"/><circle cx="8" cy="1.5" r="1"/></svg>,
  // list-check_outlined — TodoWrite/Skill
  Skill: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3 4l2 2 3-3"/><line x1="10" y1="5" x2="14" y2="5"/><path d="M3 9l2 2 3-3"/><line x1="10" y1="10" x2="14" y2="10"/></svg>,
  TodoWrite: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3 4l2 2 3-3"/><line x1="10" y1="5" x2="14" y2="5"/><path d="M3 9l2 2 3-3"/><line x1="10" y1="10" x2="14" y2="10"/></svg>,
};

function ToolIcon({ name, className }: { name: string; className?: string }) {
  const svg = TOOL_SVGS[name];
  if (svg) {
    return <span className={`inline-block w-3.5 h-3.5 text-gray-400 ${className ?? ""}`}>{svg}</span>;
  }
  // Default gear icon
  return (
    <span className={`inline-block w-3.5 h-3.5 text-gray-400 ${className ?? ""}`}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="8" cy="8" r="2.5"/>
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4"/>
      </svg>
    </span>
  );
}

function ThinkingIcon({ className }: { className?: string }) {
  return (
    <span className={`inline-block w-3.5 h-3.5 text-gray-400 ${className ?? ""}`}>
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

/** Feishu-style card for Remi responses — matches buildFinalCard() structure */
function RemiCard({ message, date, time }: { message: ChatMessage; date: string; time: string }) {
  const [showSteps, setShowSteps] = useState(false);
  const meta = message.meta;
  const toolCount = meta?.toolCount ?? message.steps?.filter(s => s.type === "tool").length ?? 0;
  const totalSteps = message.steps?.length ?? 0;
  const sessionName = message.sessionName ?? "Remi";

  return (
    <div className="max-w-[90%] rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Card header — session name like Feishu */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 bg-gray-50/50">
        <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
          R
        </div>
        <span className="text-xs font-semibold text-gray-600">{sessionName}</span>
        <span className="text-[11px] text-gray-300">{time}</span>
      </div>

      {/* Collapsible steps panel — interleaved thinking + tool_use (like Feishu's collapsible_panel) */}
      {totalSteps > 0 && (
        <div className="px-4 pt-2">
          <button
            onClick={() => setShowSteps(!showSteps)}
            className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
          >
            <span className="text-[10px]">{showSteps ? "▾" : "▸"}</span>
            Show {totalSteps} steps
          </button>
          {showSteps && (
            <div className="mt-1 mb-2 space-y-0.5 max-h-[300px] overflow-auto">
              {message.steps!.map((step, i) => (
                <div key={i} className="py-0.5">
                  {step.type === "thinking" ? (
                    <div className="flex gap-1.5 text-[11px] text-gray-400">
                      <ThinkingIcon className="flex-shrink-0 mt-0.5" />
                      <span className="whitespace-pre-wrap">{step.content}</span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1.5 text-[11px] text-gray-500">
                      <ToolIcon name={step.name ?? ""} className="flex-shrink-0 mt-0.5" />
                      <div>
                        <span className="font-mono font-medium">{step.name}</span>
                        {step.content && <span className="text-gray-300 ml-1.5 break-all">{step.content}</span>}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content body — render markdown with feishu-image support */}
      <div className="px-4 py-3">
        {message.content ? (
          <div className="prose prose-sm prose-gray max-w-none text-gray-700">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ src, alt }) => {
                  // Handle feishu-image:img_key format — proxy via board API with disk cache
                  if (src?.startsWith("feishu-image:")) {
                    const imgKey = src.replace("feishu-image:", "");
                    return <img src={`/api/image/${imgKey}`} alt={alt ?? "image"} className="max-w-full rounded my-2" loading="lazy" />;
                  }
                  return <img src={src} alt={alt ?? ""} className="max-w-full rounded" />;
                },
              }}
            >{message.content}</Markdown>
          </div>
        ) : (
          <div className="text-xs text-gray-300 italic">No text content</div>
        )}
      </div>

      {/* Stats footer — matches Feishu card column_set with standard icons */}
      {meta && (
        <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-100 text-[11px] text-gray-400">
          {meta.duration != null && (
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
              <span className="font-mono">{meta.inputTokens ?? 0}→{meta.outputTokens ?? 0}</span>
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
        </div>
      )}
    </div>
  );
}
