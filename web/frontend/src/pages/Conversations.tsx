import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { MessageSquare, Search, Clock, Coins, ArrowLeft, User, Bot, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "../api/client";
import type { ConversationSummary, ChatMessage, StepItem } from "../api/types";
import { FrontmatterDocument } from "../components/FrontmatterDocument";

export function Conversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedChat, setSelectedChat] = useState<ConversationSummary | null>(null);

  useEffect(() => { fetchConversations(); }, []);

  const fetchConversations = async () => {
    setLoading(true);
    try {
      const data = await api.getConversations(100);
      setConversations(data);
    } catch {}
    setLoading(false);
  };

  const filtered = conversations.filter(c =>
    !query || c.topic.toLowerCase().includes(query.toLowerCase()) || c.chatId.toLowerCase().includes(query.toLowerCase())
  );

  if (selectedChat) {
    return <ConversationDetail conv={selectedChat} onBack={() => setSelectedChat(null)} />;
  }

  return (
    <Layout title="Conversations" subtitle="Chat History">
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search conversations..." value={query} onChange={e => setQuery(e.target.value)} className="pl-9" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            Conversations
            <Badge variant="secondary" className="text-[10px]">{filtered.length}</Badge>
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
                  className="flex cursor-pointer items-center gap-3 border-b border-border/50 px-4 py-3 transition-colors hover:bg-accent/30"
                  onClick={() => setSelectedChat(conv)}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <MessageSquare className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium">{conv.topic}</span>
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
                    <div className="text-[10px] text-muted-foreground">{formatDate(conv.updatedAt)}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>
              ))}
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}

function ConversationDetail({ conv, onBack }: { conv: ConversationSummary; onBack: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const data = await api.getConversationMessages(conv.chatId, conv.threadId ?? undefined);
        setMessages(data);
      } catch {}
      setLoading(false);
    })();
  }, [conv.chatId, conv.threadId]);

  return (
    <Layout title="Conversation" subtitle={conv.topic}>
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-8 text-xs">
          <ArrowLeft className="mr-1 h-3 w-3" /> Back
        </Button>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>{conv.messageCount} msgs</span>
          <span>{formatTokenCount(conv.tokenCount)} tokens</span>
          {conv.totalCost > 0 && <span>${conv.totalCost.toFixed(2)}</span>}
        </div>
      </div>

      {loading ? (
        <div className="p-10 text-center text-xs text-muted-foreground">Loading messages...</div>
      ) : messages.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">No messages found</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {messages.map(msg => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>
      )}
    </Layout>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.senderType === "user";
  const [stepsOpen, setStepsOpen] = useState(false);

  return (
    <div className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Bot className="h-3.5 w-3.5 text-primary" />
        </div>
      )}
      <div className={cn("max-w-[85%] rounded-lg px-3.5 py-2.5", isUser ? "bg-accent" : "border border-border bg-card")}>
        {/* Session name for Remi */}
        {!isUser && message.sessionName && (
          <div className="mb-1 text-[10px] font-medium text-chart-1">{message.sessionName}</div>
        )}

        {/* Steps (thinking + tools) */}
        {!isUser && message.steps && message.steps.length > 0 && (
          <div className="mb-2">
            <button
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => setStepsOpen(!stepsOpen)}
            >
              {stepsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {message.steps.length} steps
              ({message.steps.filter(s => s.type === "tool").length} tools, {message.steps.filter(s => s.type === "thinking").length} thinking)
            </button>
            {stepsOpen && (
              <div className="mt-1.5 space-y-1 border-l-2 border-border pl-2">
                {message.steps.map((step, i) => (
                  <div key={i} className="text-[10px]">
                    {step.type === "tool" ? (
                      <span className="text-chart-2">
                        <Badge variant="outline" className="mr-1 px-1 py-0 text-[8px]">{step.name}</Badge>
                        <span className="text-muted-foreground">{step.content.slice(0, 80)}</span>
                      </span>
                    ) : (
                      <span className="italic text-muted-foreground">{step.content.slice(0, 120)}...</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Content */}
        <div className="text-sm">
          <FrontmatterDocument body={message.content} />
        </div>

        {/* Meta footer */}
        {!isUser && message.meta && (
          <div className="mt-2 flex flex-wrap gap-2 border-t border-border/50 pt-1.5 text-[9px] text-muted-foreground">
            <span>{message.meta.model?.replace("claude-", "").replace("-2025", "")}</span>
            <span>{((message.meta.inputTokens ?? 0) + (message.meta.outputTokens ?? 0)).toLocaleString()} tok</span>
            {message.meta.duration != null && message.meta.duration > 0 && <span>{(message.meta.duration / 1000).toFixed(1)}s</span>}
            {message.meta.cost != null && message.meta.cost > 0 && <span>${message.meta.cost.toFixed(3)}</span>}
            {message.meta.toolCount != null && message.meta.toolCount > 0 && <span>{message.meta.toolCount} tools</span>}
          </div>
        )}
      </div>
      {isUser && (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent">
          <User className="h-3.5 w-3.5 text-foreground" />
        </div>
      )}
    </div>
  );
}

function formatTokenCount(n: number): string {
  if (n > 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n > 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch { return iso.slice(0, 16); }
}
