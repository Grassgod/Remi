/**
 * The `render_version` stamped on every `body_html`.
 *
 * B1 stores it next to the HTML and the backfill task re-renders the rows whose
 * value differs, so the string has to change whenever the pipeline changes what
 * the same markdown produces. It is the input to a content hash rather than a
 * hand-edited counter, so a change that alters output cannot ship without
 * changing the value.
 *
 * Bump `RENDER_PIPELINE_REVISION` for changes that are not visible in the
 * dependency list: the sanitize schema, the URL transform, the Shiki theme
 * pair, the 64 KiB downgrade threshold, the prepasses this renderer ports.
 */
import { createHash } from "node:crypto";

/**
 * Hand-maintained knob. Also the marker the QA re-render check looks for: rows
 * written by an older pipeline carry a different version and get backfilled.
 */
export const RENDER_PIPELINE_REVISION = 1;

/**
 * Versions of the libraries whose output is part of the HTML.
 *
 * These are the resolved versions in `bun.lock`. They are listed rather than
 * read from the packages at runtime so the hash does not depend on resolution
 * order, but a mismatch is not silent: `render-markdown-backfill` renders with
 * whatever is installed, so an upgrade that is not reflected here would leave
 * stale `body_html` behind. The parity test pins this list against
 * `node_modules` for the four that decide highlighting output.
 */
export const RENDER_PIPELINE_INPUTS = {
  shiki: "3.23.0",
  katex: "0.16.47",
  "remark-parse": "11.0.0",
  "remark-gfm": "4.0.1",
  "remark-math": "6.0.0",
  "remark-breaks": "4.0.0",
  "remark-rehype": "11.1.2",
  "rehype-raw": "7.0.0",
  "rehype-sanitize": "6.0.0",
  "rehype-katex": "7.0.1",
  "rehype-stringify": "10.0.1",
} as const;

function computeRenderVersion(): string {
  const input = [
    `pipeline:${RENDER_PIPELINE_REVISION}`,
    ...Object.entries(RENDER_PIPELINE_INPUTS)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, version]) => `${name}@${version}`),
  ].join("\n");
  return `md-${createHash("sha256").update(input).digest("hex").slice(0, 16)}`;
}

/** Stable identifier for the pipeline that produced a `body_html`. */
export const RENDER_VERSION = computeRenderVersion();
