import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "~remiadmin/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";

interface MarkdownFileViewerProps {
  content: string;
  /** Pre-parsed frontmatter from backend (overrides client-side parsing) */
  metadata?: Record<string, unknown>;
  /** Fields already rendered externally — skip in auto-render */
  knownFields?: string[];
  onSave?: (content: string) => Promise<void>;
  readOnly?: boolean;
  className?: string;
}

export function MarkdownFileViewer({ content, metadata, knownFields = [], onSave, readOnly, className }: MarkdownFileViewerProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setText(content); setEditing(false); setCopied(false); }, [content]);

  const canEdit = !!onSave && !readOnly;

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(text);
    } catch { /* caller handles */ }
    setSaving(false);
    setEditing(false);
  };

  // Resolve frontmatter: prefer pre-parsed metadata, fall back to client-side parsing
  const { fm, body } = (() => {
    if (metadata) {
      const { body: parsedBody } = parseFrontmatter(content);
      return { fm: metadata, body: parsedBody };
    }
    const { frontmatter, body: parsedBody } = parseFrontmatter(content);
    if (frontmatter) {
      return { fm: yamlTextToRecord(frontmatter), body: parsedBody };
    }
    return { fm: null, body: content };
  })();

  const skip = new Set(knownFields);
  const extraKeys = fm
    ? Object.keys(fm).filter(k => !skip.has(k) && fm[k] != null && !(Array.isArray(fm[k]) && (fm[k] as unknown[]).length === 0))
    : [];

  return (
    <div className={cn("relative", className)}>
      <div className="absolute right-2 top-2 z-10 flex gap-1.5">
        {canEdit && editing && (
          <Button variant="outline" size="sm" onClick={handleSave} disabled={saving} className="h-6 text-[10px]">
            {saving ? "Saving..." : "Save"}
          </Button>
        )}
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)} className="h-6 text-[10px] text-muted-foreground">
            {editing ? "Preview" : "Edit"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] text-muted-foreground"
          onClick={() => {
            navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>
      {editing ? (
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          className="min-h-[400px] w-full resize-y rounded-md border border-border bg-muted/30 p-4 pt-9 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-input"
          spellCheck={false}
        />
      ) : (
        <div className="rounded-md border border-border bg-muted/30 p-4">
          {/* Auto-rendered frontmatter fields */}
          {extraKeys.length > 0 && (
            <div className="not-prose mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              {extraKeys.map(key => (
                <div key={key} className="contents">
                  <span className="text-muted-foreground">{formatLabel(key)}</span>
                  <div className="font-medium">{renderValue(fm![key])}</div>
                </div>
              ))}
            </div>
          )}
          {/* Markdown body */}
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body || "(empty)"}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Auto-render helpers ──────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;

function formatLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function renderValue(value: unknown) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "number") return <span>{value}</span>;
  if (typeof value === "string") {
    if (ISO_DATE_RE.test(value)) return <span>{value.slice(0, 10)}</span>;
    return <span>{value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((v, i) => <Badge key={i} variant="secondary" className="text-[10px]">{String(v)}</Badge>)}
      </div>
    );
  }
  return <span className="font-mono text-[10px]">{JSON.stringify(value)}</span>;
}

// ── Frontmatter parsing ──────────────────────────────

function parseFrontmatter(content: string): { frontmatter: string | null; body: string } {
  if (!content.startsWith("---")) return { frontmatter: null, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: content };
  return {
    frontmatter: content.slice(4, end).trim(),
    body: content.slice(end + 4).trim(),
  };
}

/** Convert raw YAML text to a Record for auto-rendering */
function yamlTextToRecord(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(\w[\w.-]*):\s*(.*)/);
    if (!match) { i++; continue; }

    const key = match[1];
    let value = match[2].trim();

    // Multi-line scalar (> or |)
    if (value === ">" || value === "|") {
      const parts: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        if (lines[i].trim()) parts.push(lines[i].trim());
        i++;
      }
      result[key] = parts.join(" ");
      continue;
    }

    // Inline array: [item1, item2]
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      result[key] = inner ? inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")) : [];
      i++;
      continue;
    }

    // Empty value — could be nested object or block list
    if (value === "") {
      i++;
      // Check for direct list items (- value)
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s+- /)) {
        items.push(lines[i].replace(/^\s+- /, "").trim());
        i++;
      }
      if (items.length > 0) {
        result[key] = items;
        continue;
      }
      // Parse nested sub-keys (e.g. compatibility: → requires: → [list])
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        const subLine = lines[i].trimStart();
        const subMatch = subLine.match(/^(\w[\w.-]*):\s*(.*)/);
        if (subMatch) {
          const subKey = subMatch[1];
          const subValue = subMatch[2].trim();
          if (subValue === "") {
            // Sub-key with block list
            const subItems: string[] = [];
            i++;
            while (i < lines.length && lines[i].match(/^\s+- /)) {
              subItems.push(lines[i].replace(/^\s+- /, "").trim());
              i++;
            }
            result[subKey] = subItems;
            continue;
          } else {
            result[subKey] = subValue;
          }
        }
        i++;
      }
      continue;
    }

    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Try to parse as number
    if (/^\d+(\.\d+)?$/.test(value)) {
      result[key] = parseFloat(value);
      i++;
      continue;
    }

    // Boolean
    if (value === "true" || value === "false") {
      result[key] = value === "true";
      i++;
      continue;
    }

    result[key] = value;
    i++;
  }

  return result;
}
