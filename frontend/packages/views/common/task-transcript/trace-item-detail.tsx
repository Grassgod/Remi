"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileChange, TraceItem } from "@multiremi/contracts/trace";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { cn } from "@multiremi/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { useT } from "../../i18n";

// Details of a command or file-change item, shared by Chat's steps fold and
// the execution dialog (Codex values, PLAN §2.5): the command at two lines
// until clicked, output at most 144px and scrolled to its end, a status
// footer with copy buttons; a file's unified diff at most 240px.

/** 13px monospace, the detail body size. */
export const TRACE_DETAIL_MONO = "font-mono text-[13px] leading-5";
const MONO = TRACE_DETAIL_MONO;

/** The command as typed: strip `$ ` and a `bash|zsh|sh -c|-lc '…'` wrapper. */
export function displayCommand(command: string | null | undefined): string {
  let text = (command ?? "").trim().replace(/^\$\s+/, "");
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(text);
  if (wrapped) text = wrapped[2]!;
  return text;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useT("chat");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" aria-label={copied ? t(($) => $.turn_steps.copied) : label} title={label}
      onClick={() => { void copyText(text).then((ok) => { if (ok) setCopied(true); }); }}
      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </button>
  );
}

/** Codex shell block: two lines of command, output at most 144px scrolled to its end, a status footer. */
export function CommandDetail({ command, output, status, exitCode, truncated = false }: {
  command: string | null;
  output: string | null;
  status: TraceItem["status"];
  exitCode: number | null;
  truncated?: boolean;
}) {
  const { t } = useT("chat");
  const [full, setFull] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const text = displayCommand(command);
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [output]);
  const footer = status === "in_progress" ? t(($) => $.turn_steps.running)
    : status === "stopped" ? t(($) => $.turn_steps.exit_stopped)
      : exitCode !== null && exitCode !== 0 ? t(($) => $.turn_steps.exit_code, { code: String(exitCode) })
        : status === "failed" || status === "declined" ? t(($) => $.turn_steps.exit_unknown)
          : t(($) => $.turn_steps.exit_success);
  return (
    <div data-command-detail className="overflow-hidden rounded-md border bg-muted/30">
      {text && (
        <button type="button" onClick={() => setFull((value) => !value)} aria-expanded={full}
          title={full ? undefined : t(($) => $.turn_steps.show_full_command)}
          className={cn(MONO, "block w-full whitespace-pre-wrap break-all px-2 py-2 text-left text-foreground focus-visible:outline-2 focus-visible:outline-ring", !full && "line-clamp-2")}>
          {text}
        </button>
      )}
      {output ? (
        <pre ref={outputRef} data-command-output
          onScroll={(event) => { const el = event.currentTarget; pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4; }}
          className={cn(MONO, "max-h-36 overflow-auto whitespace-pre border-t px-2 py-2 font-medium text-muted-foreground")}>
          {output}{truncated ? "\n…" : ""}
        </pre>
      ) : status !== "in_progress" ? (
        <div className={cn(MONO, "border-t px-2 py-2 text-muted-foreground")}>{t(($) => $.turn_steps.no_output)}</div>
      ) : null}
      <div className="flex items-center gap-1 border-t px-2 py-0.5 text-xs text-muted-foreground">
        <span data-command-status className="min-w-0 flex-1 truncate">{footer}</span>
        {text && <CopyButton text={text} label={t(($) => $.turn_steps.copy_command)} />}
        {output && <CopyButton text={output} label={t(($) => $.turn_steps.copy_output)} />}
      </div>
    </div>
  );
}

/** One file's unified diff, at most 240px, without line numbers (Claude sends snippets). */
export function DiffDetail({ change }: { change: FileChange }) {
  const { t } = useT("chat");
  if (!change.diff) {
    const note = change.diff_truncated ? t(($) => $.turn_steps.diff_too_large)
      : change.kind === "delete" ? t(($) => $.turn_steps.contents_deleted) : t(($) => $.turn_steps.no_changes);
    return <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">{note}</div>;
  }
  const lines = change.diff.split("\n");
  return (
    <div data-diff-detail className="overflow-hidden rounded-md border">
      <div className="truncate border-b bg-muted/40 px-2.5 py-0.5 text-[13px] text-muted-foreground" title={change.path}>
        {change.move_path ? `${change.path} → ${change.move_path}` : change.path}
      </div>
      <pre className={cn(MONO, "max-h-60 overflow-auto bg-muted/20 py-1")}>
        {lines.map((line, index) => line.startsWith("@@") ? (
          <div key={index} aria-hidden="true" className="my-1 border-t border-dashed" />
        ) : (
          <div key={index} className={cn("px-2.5 whitespace-pre",
            line.startsWith("+") && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            line.startsWith("-") && "bg-red-500/10 text-red-700 dark:text-red-300",
            !line.startsWith("+") && !line.startsWith("-") && "text-muted-foreground")}>
            {line || " "}
          </div>
        ))}
        {change.diff_truncated && <div className="px-2.5 text-muted-foreground">…</div>}
      </pre>
    </div>
  );
}

