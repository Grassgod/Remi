import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { MessageSquare, Search, ArrowLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "../api/client";
import type { ConversationSummary, ChatMessage, StepItem } from "../api/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

function formatListDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch { return iso.slice(0, 16); }
}

function formatTokenCount(n: number): string {
  if (n > 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n > 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

/** Clean user message: remove [Replying to: "..."] prefix, sender name, and ou_ prefix */
function cleanUserMessage(text: string): string {
  return text
    .replace(/^\[Replying to: "[^"]*"\]\s*/s, "")
    .replace(/^贺华杰:\s*/m, "")
    .replace(/^ou_[a-f0-9]+:\s*/m, "")
    .trim();
}

// ── Tool Icons (SVG, from Board MissionDetail) ────────

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

// ── Conversations List ────────────────────────────────

export function Conversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedChat, setSelectedChat] = useState<ConversationSummary | null>(null);
  const [chats, setChats] = useState<import("../api/types").ChatInfo[]>([]);
  const [filterChatId, setFilterChatId] = useState<string>("");
  const [location] = useLocation();

  const PAGE_SIZE = 50;

  // Reset detail view when sidebar navigates back to /conversations
  useEffect(() => {
    if (location === "/conversations") setSelectedChat(null);
  }, [location]);

  useEffect(() => { api.getChats().then(setChats).catch(() => {}); }, []);
  useEffect(() => { fetchConversations(true); }, [filterChatId]);

  const fetchConversations = async (reset = false) => {
    if (reset) {
      setLoading(true);
      setConversations([]);
    } else {
      setLoadingMore(true);
    }
    try {
      const offset = reset ? 0 : conversations.length;
      const data = await api.getConversations(PAGE_SIZE, offset, filterChatId || undefined);
      if (reset) {
        setConversations(data);
      } else {
        setConversations(prev => [...prev, ...data]);
      }
      setHasMore(data.length >= PAGE_SIZE);
    } catch {}
    setLoading(false);
    setLoadingMore(false);
  };

  const filtered = conversations.filter(c =>
    !query || c.topic.toLowerCase().includes(query.toLowerCase()) || c.chatId.toLowerCase().includes(query.toLowerCase())
  );

  if (selectedChat) {
    return <ConversationDetail conv={selectedChat} onBack={() => setSelectedChat(null)} />;
  }

  return (
    <Layout title="Conversations" subtitle="Chat History">
      {/* Chat filter + search */}
      <div className="flex gap-2 mb-4">
        <select
          value={filterChatId}
          onChange={e => setFilterChatId(e.target.value)}
          className="h-9 min-w-[200px] rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">All Chats ({chats.reduce((s, c) => s + c.conversationCount, 0)})</option>
          {chats.map(ch => (
            <option key={ch.chatId} value={ch.chatId}>
              {ch.isP2P ? "P2P" : "Group"}: {ch.name} ({ch.conversationCount})
            </option>
          ))}
        </select>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search conversations..." value={query} onChange={e => setQuery(e.target.value)} className="pl-9" />
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            Conversations
            <Badge variant="secondary" className="text-[10px]">{filtered.length}{hasMore ? "+" : ""}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center text-xs text-muted-foreground">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center text-xs text-muted-foreground">
              {conversations.length === 0 ? "No conversations yet" : "No matching conversations"}
            </div>
          ) : (
            <ScrollArea className="max-h-[600px]">
              {filtered.map(conv => (
                <div
                  key={conv.id}
                  className="flex cursor-pointer items-center gap-3 border-b border-border/40 dark:border-white/5 px-4 py-3 transition-colors hover:bg-accent/30"
                  onClick={() => setSelectedChat(conv)}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <MessageSquare className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{cleanUserMessage(conv.topic)}</span>
                      <Badge variant={conv.status === "active" ? "success" : "outline"} className="text-[8px]">
                        {conv.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {conv.messageCount} messages · {formatTokenCount(conv.tokenCount)} tokens
                      {conv.totalCost > 0 && ` · $${conv.totalCost.toFixed(2)}`}
                    </div>
                  </div>
                  <div className="hidden shrink-0 text-right sm:block">
                    <div className="text-[10px] text-muted-foreground">{formatListDate(conv.updatedAt)}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>
              ))}
              {hasMore && !query && (
                <div className="p-3 text-center">
                  <Button variant="ghost" size="sm" className="text-xs" disabled={loadingMore} onClick={() => fetchConversations(false)}>
                    {loadingMore ? "Loading..." : "Load More"}
                  </Button>
                </div>
              )}
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}

// ── Conversation Detail ───────────────────────────────

function ConversationDetail({ conv, onBack }: { conv: ConversationSummary; onBack: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.getConversationMessages(conv.chatId, conv.threadId ?? undefined, conv.sessionId ?? undefined);
        setMessages(data);
        setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "instant" }), 100);
      } catch (e) {
        setError((e as Error).message);
      }
      setLoading(false);
    })();
  }, [conv.chatId, conv.threadId, conv.sessionId]);

  const topicClean = cleanUserMessage(conv.topic);

  return (
    <Layout
      title=""
      actions={
        <div>
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="shrink-0 text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <h2 className="text-sm font-semibold text-foreground leading-tight">{topicClean}</h2>
          </div>
          <div className="flex items-center gap-2 mt-1 ml-7 text-[10px] text-muted-foreground">
            <span>{conv.messageCount} msgs</span>
            <span className="text-muted-foreground/30">·</span>
            <span>{formatTokenCount(conv.tokenCount)} tokens</span>
            {conv.totalCost > 0 && <><span className="text-muted-foreground/30">·</span><span>${conv.totalCost.toFixed(2)}</span></>}
            <span className="text-muted-foreground/30">·</span>
            <button
              className="font-mono text-muted-foreground/30 hover:text-primary transition-colors"
              onClick={() => {
                const doCopy = () => {
                  try { navigator.clipboard.writeText(conv.id); } catch {
                    const ta = document.createElement("textarea");
                    ta.value = conv.id;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand("copy");
                    document.body.removeChild(ta);
                  }
                };
                doCopy();
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              title="Copy ID"
            >{copied ? "Copied!" : conv.id}</button>
          </div>
        </div>
      }
    >

      {loading ? (
        <div className="p-10 text-center text-xs text-muted-foreground animate-pulse">Loading messages...</div>
      ) : error ? (
        <div className="p-10 text-center text-sm text-destructive">{error}</div>
      ) : messages.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">No messages found</CardContent></Card>
      ) : (
        <div className="mx-auto max-w-[800px] space-y-4">
          {messages.map(msg => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          <div ref={chatEndRef} />
        </div>
      )}
    </Layout>
  );
}

// ── Message Bubble ────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  const isBot = message.senderType === "app";
  const time = formatTime(message.createTime);
  const date = formatDate(message.createTime);

  if (isBot) return <RemiCard message={message} date={date} time={time} />;

  // User message — right aligned
  const cleaned = cleanUserMessage(message.content ?? "");
  if (!cleaned) return null;

  return (
    <div className="flex flex-col items-end">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] text-muted-foreground/60">{date} {time}</span>
        <span className="text-xs font-medium text-muted-foreground font-mono">
          {!message.senderId ? "User" : message.senderId === "ou_f4ed0b435518ee382e7e06c147a9db9f" ? "Jack" : message.senderId}
        </span>
      </div>
      <div className="max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-accent">
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// ── Remi Card (Feishu-style, ported from Board) ──────

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
            <span className="text-[10px]">{showSteps ? "\u25be" : "\u25b8"}</span>
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
        </div>
      )}
    </div>
  );
}
