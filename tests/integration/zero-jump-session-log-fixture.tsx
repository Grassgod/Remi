/**
 * Fixture page for the MUL-443 zero-jump self-test.
 *
 * It mounts the real `SessionLogList` over a `MemorySessionReplica` — the same
 * port C7 implements — in a plain page, with no API, no Next build and no
 * database. That is the point: the scenarios this file can produce (append 20,
 * grow a row, resize the container, release the pin) are exactly the ones the
 * acceptance names, and none of them needs a server to be real.
 *
 * The control surface is exposed on `window.__mul443SessionLog` for the driver.
 * It is deliberately imperative: the driver has to perturb the page at a moment
 * it chooses (during the reveal window, or after the pin released), and a React
 * prop would only let it perturb on a render.
 */
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { LocaleResources } from "@multiremi/core/i18n";
import { MemorySessionReplica, type SessionLogEntry } from "@multiremi/core/replica";
import { SessionLogList } from "@multiremi/views/common/session-log";

const SESSION_ID = "ises_fixture";
/**
 * Rows at load: enough that the viewport has real scroll range both before and
 * after the 20-row append. A fixture shorter than its own container would give
 * every scenario zero travel and report a meaningless `jumps = 0`.
 */
const INITIAL_ROWS = 60;

/** The i18n slice the list reads. Inlined so the fixture needs no locale files. */
const RESOURCES = {
  en: {
    chat: {
      session_log: {
        copy_code: "Copy code",
        copied: "Copied",
        new_messages_one: "{{count}} new message",
        new_messages_other: "{{count}} new messages",
        new_messages_overflow: "99+ new messages",
        new_messages_jump: "Jump to the end, {{count}} new messages",
      },
    },
  },
} as unknown as Record<string, LocaleResources>;

/**
 * One row's markdown.
 *
 * The mix is deliberate: code blocks exercise the copy button, and every fifth
 * row is a Mermaid fence, which the enhancement swaps for a fixed-height slot
 * and then fills asynchronously. That swap is the one place the "the enhancement
 * must not change height" rule can be broken in a way a measurement would catch,
 * so the fixture has to contain it.
 */
function bodyMarkdown(index: number): string {
  if (index % 5 === 0) {
    return [`**Row ${index}**`, "", "```mermaid", `graph TD; A${index}-->B${index};`, "```"].join("\n");
  }
  if (index % 5 === 1) {
    return [`**Row ${index}**`, "", "```js", `const value = ${index};`, "```"].join("\n");
  }
  if (index % 5 === 2) {
    return [`**Row ${index}**`, "", "A short paragraph that wraps once or twice at the fixture width."].join("\n");
  }
  if (index % 5 === 3) {
    return [`**Row ${index}**`, "", "- one", "- two", "- three"].join("\n");
  }
  return [`**Row ${index}**`, "", "long ".repeat(60)].join("\n");
}

/**
 * `body_html` is what `renderMarkdown` would have produced. Hand-written rather
 * than rendered, so this page has no dependency on the server package; the
 * enhancement only looks at markup shape and at the fence text in `body_md`.
 */
function bodyHtml(index: number): string {
  if (index % 5 === 0) {
    // Shiki renders a mermaid fence as an ordinary highlighted block; only the
    // fence text in `body_md` says it is a diagram. The block is deliberately
    // short, so the slot the enhancement builds is short too and the diagram it
    // receives has to be clipped rather than allowed to grow it.
    return [
      `<p><strong>Row ${index}</strong></p>`,
      `<pre class="shiki"><code>graph TD; A${index}--&gt;B${index};</code></pre>`,
    ].join("");
  }
  if (index % 5 === 1) {
    return [
      `<p><strong>Row ${index}</strong></p>`,
      `<pre class="shiki"><code>const value = ${index};</code></pre>`,
    ].join("");
  }
  if (index % 5 === 3) {
    return `<p><strong>Row ${index}</strong></p><ul><li>one</li><li>two</li><li>three</li></ul>`;
  }
  return `<p><strong>Row ${index}</strong></p><p>${
    index % 5 === 4 ? "long ".repeat(60) : "A short paragraph that wraps once or twice at the fixture width."
  }</p>`;
}

function entry(seq: number, revision = 1): SessionLogEntry {
  return {
    session_id: SESSION_ID,
    seq,
    id: `cmt_${seq}`,
    revision,
    kind: "message",
    body_html: bodyHtml(seq),
    render_version: "md-fixture",
    body_md: bodyMarkdown(seq),
  };
}

function initialEntries(): SessionLogEntry[] {
  return Array.from({ length: INITIAL_ROWS }, (_, index) => entry(index + 1));
}

interface FixtureControl {
  /** Append `count` new rows at the end of the stream. */
  append(count: number): void;
  /**
   * Change one row's height, the way a late image or a resolved Shiki pass does.
   *
   * `seq` defaults to the last row, which is the only place a reader parked
   * above the end can absorb growth without their viewport moving: every row
   * they can see keeps its offset, and the new content lands below them.
   */
  growRow(seq?: number, revision?: number): void;
  /** Resize the page's container, which resizes the scroll root with it. */
  setWidth(px: number): void;
  /** Flip the replica's freshness verdict. */
  setFresh(ready: boolean): void;
  /**
   * The same three perturbations, applied inside a `requestAnimationFrame`
   * callback.
   *
   * The recorder samples on its own rAF loop, installed at document start, and
   * re-arms at the end of each tick — so it always has exactly one pending
   * frame, and a callback registered afterwards runs strictly *between* two
   * samples. A plain synchronous mutation instead lands before the next sample,
   * which means the recorder never observes a frame showing the old height and
   * the scenario measures nothing. Each returns a promise that settles once the
   * mutation has been applied, so the driver can await it.
   */
  appendBetweenFrames(count: number): Promise<void>;
  growRowBetweenFrames(seq?: number, revision?: number): Promise<void>;
  setWidthBetweenFrames(px: number): Promise<void>;
  /** The positive control: scroll the list by a known amount, between two frames. */
  scrollByBetweenFrames(deltaPx: number): Promise<void>;
  /** Replace one row's body with a `body_html: null` variant (degraded_render). */
  degradeRowBetweenFrames(seq: number): Promise<void>;
  /** Snapshot the facts a scenario asserts on. */
  state(): FixtureState;
}

/** What one snapshot of the fixture reports. */
export interface FixtureState {
  head: number | null;
  rows: number;
  revisionOfFirst: number | null;
  width: number;
  perfState: string | null;
  perfFresh: string | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
  newMessages: string | null;
  /** Rows that fell back to the client renderer (`degraded_render`). */
  degraded: number;
  /**
   * Distance from the end of the content, in pixels. The scenarios perturbs the
   * list while it is released, so this value is how the driver proves the state
   * it claims to be measuring is the state it is in (the stick hook's own
   * threshold is 24px).
   */
  bottomDistance: number;
}

declare global {
  interface Window {
    __mul443SessionLog?: FixtureControl;
  }
}

const replica = new MemorySessionReplica({
  [SESSION_ID]: { entries: initialEntries(), ready: true, fresh: true },
});

/** The element the scenarios resize; the list fills it. */
const frame = document.createElement("div");
frame.id = "fixture-frame";
frame.style.cssText = [
  "display:flex",
  "flex-direction:column",
  "width:800px",
  "height:400px",
  "margin:0",
  "padding:0",
].join(";");

// The list is a flex column that fills its parent, exactly as it is mounted in
// the app: the shell is what has a height, the list is what scrolls.
//
// The shell is sized with inline styles rather than Tailwind classes on purpose.
// Tailwind's `@source` rules scan the three frontend packages, not `tests/`, so a
// `flex-1` in this file would be generated for nobody: the host would size to its
// content, the list's `h-full` would resolve against that, and the page would
// have no scroll box at all — which is a zero-jump check that measures nothing.
// (Found the hard way; the scroll root reported a 2200px client height while the
// frame was 400px.)
const host = document.createElement("div");
host.id = "fixture-host";
host.style.cssText = [
  "display:flex",
  "flex-direction:column",
  "flex:1 1 0%",
  "min-height:0",
  "overflow:hidden",
].join(";");
frame.appendChild(host);
document.body.appendChild(frame);

createRoot(host).render(
  <I18nProvider locale="en" resources={RESOURCES}>
    <SessionLogList
      sessionId={SESSION_ID}
      replica={replica}
      resetKey={`fixture:${SESSION_ID}`}
      testIdPrefix="fixture-session-log"
      // The degrade path's client renderer. Kept deliberately crude: the point of
      // the scenario is that a row without `body_html` renders *something* of
      // roughly the same height without moving the reader, not that this fallback
      // is pretty.
      renderFallback={(item) => (
        <p data-fixture-degraded="" style={{ margin: 0 }}>
          {item.body_md}
        </p>
      )}
    />
  </I18nProvider>,
);

/** Applies `mutate` between two recorder samples. See the control-surface comment. */
function inFrame(mutate: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      mutate();
      resolve();
    });
  });
}

window.__mul443SessionLog = {
  append: (count: number) => {
    const current = replica.getSnapshot(SESSION_ID);
    const start = current.entries.length > 0
      ? current.entries[current.entries.length - 1]!.seq + 1
      : 1;
    replica.append(SESSION_ID, Array.from({ length: count }, (_, index) => entry(start + index)));
  },
  growRow: (seq, revision = 2) => {
    const current = replica.getSnapshot(SESSION_ID);
    const resolved = seq ?? (current.entries.length > 0 ? current.entries[current.entries.length - 1]!.seq : null);
    if (resolved === null) return;
    const target = current.entries.find((item) => item.seq === resolved);
    if (!target) return;
    // A taller body at a new revision: the height cache must miss on purpose, so
    // this is the exact case a stale reservation would get wrong.
    replica.append(SESSION_ID, [{
      ...target,
      revision,
      body_md: `${target.body_md}\n\n${"grown ".repeat(80)}`,
      body_html: `${target.body_html ?? ""}<p>${"grown ".repeat(80)}</p>`,
    }]);
  },
  setWidth: (px: number) => {
    frame.style.width = `${px}px`;
  },
  setFresh: (ready: boolean) => {
    replica.setFreshness(SESSION_ID, ready);
  },
  appendBetweenFrames: (count: number) => inFrame(() => {
    const current = replica.getSnapshot(SESSION_ID);
    const start = current.entries.length > 0
      ? current.entries[current.entries.length - 1]!.seq + 1
      : 1;
    replica.append(SESSION_ID, Array.from({ length: count }, (_, index) => entry(start + index)));
  }),
  growRowBetweenFrames: (seq?: number, revision = 2) => inFrame(() => {
    const current = replica.getSnapshot(SESSION_ID);
    const resolved = seq ?? (current.entries.length > 0 ? current.entries[current.entries.length - 1]!.seq : null);
    if (resolved === null) return;
    const target = current.entries.find((item) => item.seq === resolved);
    if (!target) return;
    replica.append(SESSION_ID, [{
      ...target,
      revision,
      body_md: `${target.body_md}\n\n${"grown ".repeat(80)}`,
      body_html: `${target.body_html ?? ""}<p>${"grown ".repeat(80)}</p>`,
    }]);
  }),
  setWidthBetweenFrames: (px: number) => inFrame(() => {
    frame.style.width = `${px}px`;
  }),
  scrollByBetweenFrames: (deltaPx: number) => inFrame(() => {
    const root = document.querySelector("[data-session-log-scroll]") as HTMLElement | null;
    if (!root) return;
    root.scrollTop = Math.max(0, root.scrollTop - deltaPx);
  }),
  degradeRowBetweenFrames: (seq: number) => inFrame(() => {
    const current = replica.getSnapshot(SESSION_ID);
    const target = current.entries.find((item) => item.seq === seq);
    if (!target) return;
    // A new revision whose HTML is missing is what the backfill window looks
    // like: the row has to fall back to the client renderer without moving.
    replica.append(SESSION_ID, [{ ...target, revision: target.revision + 1, body_html: null }]);
  }),
  state: () => {
    const snapshot = replica.getSnapshot(SESSION_ID);
    const root = document.querySelector("[data-session-log-scroll]") as HTMLElement | null;
    const chip = document.querySelector("[data-session-log-new-messages]");
    return {
      head: snapshot.head,
      rows: document.querySelectorAll("[data-perf-item]").length,
      revisionOfFirst: snapshot.entries[0]?.revision ?? null,
      width: frame.getBoundingClientRect().width,
      perfState: root?.getAttribute("data-perf-state") ?? null,
      perfFresh: root?.getAttribute("data-perf-fresh") ?? null,
      scrollTop: root?.scrollTop ?? 0,
      scrollHeight: root?.scrollHeight ?? 0,
      clientHeight: root?.clientHeight ?? 0,
      clientWidth: root?.clientWidth ?? 0,
      newMessages: chip?.textContent?.trim() ?? null,
      bottomDistance: root ? root.scrollHeight - root.scrollTop - root.clientHeight : 0,
      degraded: Number(root?.getAttribute("data-session-log-degraded") ?? "0"),
    };
  },
};
