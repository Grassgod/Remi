"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FileChange, TraceItem } from "@multiremi/contracts/trace";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { cn } from "@multiremi/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { useT } from "../../i18n";

// Details of a command or file-change item, shared by Chat's steps fold and
// the execution dialog (Codex values, PLAN §2.5): the command at two lines
// with 展开 / 收起 when it overflows, wrapped output at most 144px, each block
// with its own copy button, a status footer; a file's unified diff at most 240px.

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

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
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
      className={cn("inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", className)}>
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </button>
  );
}

/** A block's copy button: its top-right corner, on hover or focus (always on touch screens). */
const CORNER_COPY = "absolute top-1 right-1 bg-background opacity-0 shadow-xs transition-opacity group-hover/block:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none";

/**
 * The command, clamped to two lines. Only a clamped box can tell that it
 * overflows, so it is measured while clamped (and again on resize); once
 * expanded, 收起 stays until the reader folds it back.
 */
function CommandText({ text }: { text: string }) {
  const { t } = useT("chat");
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || full) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [full, text]);
  return (
    <div data-command-block className="group/block relative px-2 py-2">
      {/* The clamp sits on a box without padding, so a third line cannot show
       * through the padding; `block` would override the clamp's
       * `display: -webkit-box`, so only one of the two applies. */}
      <div ref={ref} id={id} data-command-text className={cn(MONO, "whitespace-pre-wrap break-all text-foreground", full ? "block" : "line-clamp-2")}>
        {text}
      </div>
      {(overflows || full) && (
        <button type="button" onClick={() => setFull((value) => !value)} aria-expanded={full} aria-controls={id}
          className="mt-1 cursor-pointer rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          {full ? t(($) => $.turn_steps.collapse_command) : t(($) => $.turn_steps.expand_command)}
        </button>
      )}
      <CopyButton text={text} label={t(($) => $.turn_steps.copy_command)} className={CORNER_COPY} />
    </div>
  );
}

/** Codex shell block: two lines of command, wrapped output at most 144px, a status footer. */
export function CommandDetail({ command, output, status, exitCode, truncated = false }: {
  command: string | null;
  output: string | null;
  status: TraceItem["status"];
  exitCode: number | null;
  truncated?: boolean;
}) {
  const { t } = useT("chat");
  const outputRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const text = displayCommand(command);
  const running = status === "in_progress";
  // A running command follows its output's end until the reader scrolls up;
  // a finished one opens at the top.
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (el && running && pinned.current) el.scrollTop = el.scrollHeight;
  }, [output, running]);
  const footer = running ? t(($) => $.turn_steps.running)
    : status === "stopped" ? t(($) => $.turn_steps.exit_stopped)
      : exitCode !== null && exitCode !== 0 ? t(($) => $.turn_steps.exit_code, { code: String(exitCode) })
        : status === "failed" || status === "declined" ? t(($) => $.turn_steps.exit_unknown)
          : t(($) => $.turn_steps.exit_success);
  return (
    <div data-command-detail className="overflow-hidden rounded-md border bg-muted/30">
      {text && <CommandText text={text} />}
      {output ? (
        <div data-output-block className={cn("group/block relative", text && "border-t")}>
          <pre ref={outputRef} data-command-output
            onScroll={(event) => { const el = event.currentTarget; pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4; }}
            className={cn(MONO, "max-h-36 overflow-y-auto whitespace-pre-wrap break-words px-2 py-2 font-medium text-muted-foreground")}>
            {output}{truncated ? "\n…" : ""}
          </pre>
          <CopyButton text={output} label={t(($) => $.turn_steps.copy_output)} className={CORNER_COPY} />
        </div>
      ) : !running ? (
        <div className={cn(MONO, "px-2 py-2 text-muted-foreground", text && "border-t")}>{t(($) => $.turn_steps.no_output)}</div>
      ) : null}
      <div className="flex min-h-7 items-center border-t px-2 py-0.5 text-xs text-muted-foreground">
        <span data-command-status className="min-w-0 flex-1 truncate">{footer}</span>
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

