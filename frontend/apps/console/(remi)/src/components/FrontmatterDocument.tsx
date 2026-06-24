import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "./ui/badge";

interface Props {
  metadata?: Record<string, unknown>;
  body?: string;
  /** Fields already rendered externally — skip in auto-render */
  knownFields?: string[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;

function formatLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function renderValue(value: unknown) {
  if (value == null) return <span className="text-muted-foreground">—</span>;

  if (typeof value === "boolean")
    return <span>{value ? "Yes" : "No"}</span>;

  if (typeof value === "number")
    return <span>{value}</span>;

  if (typeof value === "string") {
    if (ISO_DATE_RE.test(value)) return <span>{value.slice(0, 10)}</span>;
    return <span>{value}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((v, i) => (
          <Badge key={i} variant="secondary" className="text-[10px]">
            {String(v)}
          </Badge>
        ))}
      </div>
    );
  }

  return <span className="font-mono text-[10px]">{JSON.stringify(value)}</span>;
}

export function FrontmatterDocument({ metadata, body, knownFields = [] }: Props) {
  const skip = new Set(knownFields);
  const extraKeys = metadata
    ? Object.keys(metadata).filter(k => !skip.has(k) && metadata[k] != null)
    : [];

  return (
    <div className="space-y-4">
      {extraKeys.length > 0 && (
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          {extraKeys.map(key => {
            const val = metadata![key];
            // Skip empty arrays
            if (Array.isArray(val) && val.length === 0) return null;
            return (
              <div key={key} className="contents">
                <span className="text-muted-foreground">{formatLabel(key)}</span>
                <div className="font-medium">{renderValue(val)}</div>
              </div>
            );
          })}
        </div>
      )}

      {body && (
        <div className="prose prose-sm prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
