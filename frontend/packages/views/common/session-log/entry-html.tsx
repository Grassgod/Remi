"use client";

/**
 * EntryHtml — one log row whose body is already rendered (MUL-403 plan 3/6 §3).
 *
 * The component's whole job is `dangerouslySetInnerHTML` plus the post-mount
 * enhancement `enhance.ts` performs. Two rules keep it from moving the page:
 *
 * 1. **The HTML is final.** It was sanitized by `renderMarkdown` on the server
 *    with the same schema the client uses, so nothing here re-parses markdown or
 *    re-highlights code. Re-rendering would be both slower and a second
 *    sanitizer to keep in sync.
 * 2. **The enhancement is height-neutral.** `enhanceEntryHtml` runs in a layout
 *    effect, before paint, and every element it adds is either absolutely
 *    positioned or a fixed-height slot; a preview therefore never resizes the
 *    row it lives in, however slowly Mermaid or the iframe resolves.
 *
 * `body_html` empty is the degrade path (`degraded_render` on the replica, per
 * plan 3/6 §3): the row falls back to the client renderer, which is slower but
 * renders the same content. That fallback is owned by the caller, since only it
 * knows which markdown component to reach for; this component just reports the
 * condition through `onDegradedRender`.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { MermaidDiagram } from "../../editor/mermaid-diagram";
import { HtmlPreviewBody } from "../../editor/html-preview-body";
import {
  enhanceEntryHtml,
  type EntryPreviewSlot,
  type EnhancedEntryHtml,
} from "./enhance";

export interface EntryHtmlProps {
  /** Server-rendered, sanitized body. Empty or null selects the degrade path. */
  html: string | null;
  /** The markdown `html` was rendered from; the enhancement matches fences against it. */
  markdown: string;
  /**
   * Called once per mount when `html` is empty, so the consumer can count
   * `degraded_render` against the replica. Never called when HTML is present.
   */
  onDegradedRender?: () => void;
  /** Rendered instead of `html` when `html` is empty. */
  fallback?: React.ReactNode;
  className?: string;
}

/** Fixed slot for a Mermaid diagram; the slot's own height is the block's. */
function MermaidSlot({ slot }: { slot: EntryPreviewSlot }): React.ReactElement {
  return createPortal(<MermaidDiagram chart={slot.source} />, slot.element);
}

/** Fixed slot for a sandboxed HTML preview. */
function HtmlSlot({ slot }: { slot: EntryPreviewSlot }): React.ReactElement {
  return createPortal(
    <HtmlPreviewBody source={{ kind: "inline", html: slot.source }} title="HTML preview" className="h-full" />,
    slot.element,
  );
}

export function EntryHtml({
  html,
  markdown,
  onDegradedRender,
  fallback = null,
  className,
}: EntryHtmlProps): React.ReactElement {
  const { t } = useT("chat");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [slots, setSlots] = useState<readonly EntryPreviewSlot[]>([]);
  const degraded = !html;

  // The enhancement returns DOM nodes that the portals above mount into. They
  // are produced in a layout effect and cleared on every teardown, so a row that
  // is recycled by the window never inherits another row's diagrams.
  const copyLabel = t(($) => $.session_log.copy_code);
  const copiedLabel = t(($) => $.session_log.copied);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || degraded) {
      setSlots([]);
      return;
    }
    const enhanced: EnhancedEntryHtml = enhanceEntryHtml(host, {
      markdown,
      copyLabel,
      copiedLabel,
    });
    setSlots(enhanced.slots);
    return () => {
      enhanced.dispose();
      setSlots([]);
    };
  }, [html, markdown, copyLabel, copiedLabel, degraded]);

  // Reported from an effect rather than during render: the consumer increments a
  // counter, and a render-phase callback would fire twice under StrictMode and
  // once per re-render of an unchanged row.
  const reported = useRef(false);
  useEffect(() => {
    if (!degraded) {
      reported.current = false;
      return;
    }
    if (reported.current) return;
    reported.current = true;
    onDegradedRender?.();
  }, [degraded, onDegradedRender]);

  const portals = useMemo(
    () => slots.map((slot) => (
      slot.kind === "mermaid"
        ? <MermaidSlot key={`mermaid:${slot.heightPx}:${slot.source.length}`} slot={slot} />
        : <HtmlSlot key={`html:${slot.heightPx}:${slot.source.length}`} slot={slot} />
    )),
    [slots],
  );

  if (degraded) return <>{fallback}</>;

  return (
    <>
      <div
        ref={hostRef}
        className={className}
        data-entry-html=""
        // eslint-disable-next-line react/no-danger -- body_html is server-sanitized by renderMarkdown
        dangerouslySetInnerHTML={{ __html: html ?? "" }}
      />
      {portals}
    </>
  );
}
