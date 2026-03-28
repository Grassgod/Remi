import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownFileViewerProps {
  content: string;
  onSave?: (content: string) => Promise<void>;
  readOnly?: boolean;
  className?: string;
}

export function MarkdownFileViewer({ content, onSave, readOnly, className }: MarkdownFileViewerProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setText(content); setEditing(false); }, [content]);

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

  return (
    <div className={className}>
      {canEdit && (
        <div className="mb-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)} className="h-7 text-xs">
            {editing ? "Preview" : "Edit"}
          </Button>
          {editing && (
            <Button variant="outline" size="sm" onClick={handleSave} disabled={saving} className="h-7 text-xs">
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      )}
      {editing ? (
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          className="min-h-[400px] w-full resize-y rounded-md border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-input"
          spellCheck={false}
        />
      ) : (
        <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border bg-muted/30 p-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || "(empty)"}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
