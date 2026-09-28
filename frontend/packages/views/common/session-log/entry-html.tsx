"use client";

/**
 * EntryHtml — one log row whose body is already rendered (MUL-403 plan 3/6 §3).
 *
 * The component's whole job is to put `body_html` into the DOM and then attach
 * the enhancement `enhance.ts` produces. Two rules keep it from moving the page:
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
 * The body is assigned through the ref rather than through
 * `dangerouslySetInnerHTML`, and that is deliberate: React re-applies
 * `dangerouslySetInnerHTML` on every re-render of this component (React 19
 * restores the markup, discarding any node a layout effect added inside it).
 * Mounting the preview portals is exactly such a re-render, so rendering the
 * HTML declaratively would erase the enhancement as soon as it appeared. React
 * therefore owns only the host element, and this component owns its children.
 *
 * `body_html` empty is the degrade path the plan names (`degraded_render`): the
 * row reports it through `onDegradedRender` and renders `fallback`, which the
 * caller supplies because only it knows which client renderer to reach for.
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

  const copyLabel = t(($) => $.session_log.copy_code);
  const copiedLabel = t(($) => $.session_log.copied);

  // Mount, then enhance: the height a preview slot copies is the height the
  // row's block already has, so the body has to be laid out before this runs.
  // A layout effect is what guarantees that, and it runs before paint.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    setSlots([]);
    if (degraded) return;

    host.innerHTML = html ?? "";
    const enhanced: EnhancedEntryHtml = enhanceEntryHtml(host, {
      markdown,
      copyLabel,
      copiedLabel,
    });
    setSlots(enhanced.slots);

    return () => {
      enhanced.dispose();
      host.replaceChildren();
      setSlots([]);
    };
  }, [html, markdown, copyLabel, copiedLabel, degraded]);

  // Reported from an effect rather than during render: the consumer increments a
  // counter, and a render-phase callback would fire twice under StrictMode.
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
    () => slots.map((slot, index) => (
      slot.kind === "mermaid"
        ? <MermaidSlot key={`mermaid:${index}`} slot={slot} />
        : <HtmlSlot key={`html:${index}`} slot={slot} />
    )),
    [slots],
  );

  if (degraded) return <>{fallback}</>;

  return (
    <>
      {/* React owns this element only; its children are mounted by the layout
          effect above, which is what keeps the enhancement from being discarded
          on the re-render that mounting the portals causes. */}
      <div ref={hostRef} className={className} data-entry-html="" />
      {portals}
    </>
  );
}
