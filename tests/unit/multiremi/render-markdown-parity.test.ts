/**
 * `renderMarkdown` must produce the HTML the browser already produces for the
 * same markdown.
 *
 * MUL-439 asks for a snapshot comparison against the frontend's current
 * rendering over 20 representative inputs (code blocks, tables, math, mentions,
 * inline HTML, oversized fences). The reference is the real component: this
 * test renders `frontend/packages/ui/markdown` through `react-dom/server` and
 * compares it with the server's output for the same markdown.
 *
 * Why it is a structural rather than byte comparison:
 *
 * - The interactive chrome legitimately exists only in the browser. `CodeBlock`
 *   renders a language header, a copy button and a tooltip; the server cannot,
 *   because those need event handlers, and the client attaches them after
 *   injecting `body_html` (plan 3/6 §3). The fenced block itself — the Shiki
 *   `<pre>` the client would inject — is compared in full.
 * - The browser's own `div.markdown-content` wrapper is React's container;
 *   `EntryHtml` supplies an equivalent container, so it is dropped on the
 *   browser side only.
 *
 * Everything else has to match exactly: same elements, same nesting, same text,
 * same link targets. That is what "the first paint does not move" requires,
 * because `body_html` is what paints before hydration.
 *
 * `render-markdown-compare.ts` holds the normaliser; the fixtures are in
 * `render-markdown-fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, RENDER_VERSION, SANITIZE_SCHEMA } from "@multiremi/render/markdown.js";
import { RENDER_PIPELINE_INPUTS } from "@multiremi/render/render-version.js";
import { FIXTURES } from "./render-markdown-fixtures.js";
import { describeNodes, normalizeBrowserHtml, normalizeHtml } from "./render-markdown-compare.js";

interface MinimalMarkdownProps {
  children: string;
  mode?: string;
  cdnDomain?: string;
}

interface MinimalMarkdownModule {
  /** React component: props in, element out. */
  Markdown: (props: MinimalMarkdownProps) => React.ReactElement;
  /** The sanitize schema the component uses; compared against the server's. */
  sanitizeSchema: Record<string, unknown>;
}

/**
 * Turn a sanitize schema into a plain, comparable structure.
 *
 * `toEqual` treats two distinct `RegExp` objects as different, and the schema
 * carries regex whitelists (`/^language-/`), so each one is rendered back to its
 * source string. Arrays and plain objects are copied; anything else is left
 * alone so an unexpected value type still shows up in the diff.
 */
function normalizeSchema(value: unknown): unknown {
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeSchema(entry);
    }
    return out;
  }
  return value;
}

/**
 * The browser component, through the ui package's export map.
 *
 * The specifier is held in a variable so the root `tsconfig.json` does not
 * follow it into the frontend ui package's TypeScript sources. That program has
 * no `jsx` setting and does not include the frontend tree, so a literal
 * specifier here turns `bunx tsc --noEmit` red for a file the frontend's own
 * typecheck already covers (`bun run typecheck:frontend`). The import still
 * resolves at runtime, and if the export map stops exposing `Markdown`, this
 * test fails.
 */
const FRONTEND_MARKDOWN_SPECIFIER = "@multiremi/ui/markdown";
const FRONTEND_MD = (await import(FRONTEND_MARKDOWN_SPECIFIER)) as unknown as MinimalMarkdownModule;

describe("renderMarkdown parity with frontend Markdown.tsx (MUL-439)", () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const server = renderMarkdown(fixture.markdown, { cdnDomain: fixture.cdnDomain });
      const browser = renderToStaticMarkup(
        React.createElement(FRONTEND_MD.Markdown, {
          // `minimal` is the mode messages and comments use; it is the mode
          // `body_html` has to match.
          mode: "minimal",
          children: fixture.markdown,
          ...(fixture.cdnDomain ? { cdnDomain: fixture.cdnDomain } : {}),
        }),
      );

      if (fixture.skipStructureCompare) {
        // The one documented divergence: a fence past 64 KiB stays a plain
        // `<pre>` on the server, while the browser's `CodeBlock` highlights it
        // once its async pass resolves. Both sides ship the same code text, so
        // nothing is hidden — the server just declines to spend the write-path
        // budget on a paste that large. Asserted positively so the fixture
        // cannot silently stop testing anything.
        expect(server.downgraded).toBe(true);
        expect(server.html).toContain("<pre>");
        expect(server.html).not.toContain("shiki");
        expect(server.html).toContain("const oversized = 1;");
        expect(browser).toContain("const oversized = 1;");
        return;
      }

      const serverNodes = describeNodes(normalizeHtml(server.html)).join("\n");
      const browserNodes = describeNodes(normalizeBrowserHtml(browser)).join("\n");
      expect(serverNodes, `${fixture.name}: structure differs from frontend Markdown.tsx`).toBe(
        browserNodes,
      );
    });
  }

  test("the server keeps the internal link targets the client needs", () => {
    // The structural comparison collapses mention and slash links to their
    // visible text, because the browser component has already replaced them
    // with a chip by the time it serialises. The targets themselves are the
    // server's job: `body_html` is what the client parses to decide which chip
    // to attach, so they are asserted here.
    expect(renderMarkdown("[@Design](mention://agent/agt_73qwsj3w60ue)").html).toContain(
      'href="mention://agent/agt_73qwsj3w60ue"',
    );
    expect(renderMarkdown("[deploy](slash://skill/skill-abc)").html).toContain(
      'href="slash://skill/skill-abc"',
    );
    // The legacy shortcode prepass has to reach the same link form.
    expect(renderMarkdown('[@ id="agt_1" label="Bob"]').html).toContain('href="mention://member/agt_1"');
  });

  test("every fixture renders and carries the current render_version", () => {
    for (const fixture of FIXTURES) {
      const result = renderMarkdown(fixture.markdown, { cdnDomain: fixture.cdnDomain });
      expect(result.render_version).toBe(RENDER_VERSION);
      expect(result.html.length).toBeGreaterThan(0);
    }
  });

  test("RENDER_PIPELINE_INPUTS matches the installed versions that shape output", async () => {
    // A dependency bump that changes highlighting or math output has to move
    // RENDER_VERSION, or the backfill task would leave stale body_html rows in
    // place. Reading the installed manifests turns that into a test failure
    // instead of a silently stale cache.
    for (const pkg of ["shiki", "katex", "rehype-katex", "remark-parse", "rehype-sanitize"]) {
      const manifestPath = import.meta.resolve(`${pkg}/package.json`);
      const manifest = JSON.parse(
        await Bun.file(new URL(manifestPath)).text(),
      ) as { version: string };
      expect(
        manifest.version,
        `${pkg} differs from RENDER_PIPELINE_INPUTS; update the version list and RENDER_PIPELINE_REVISION`,
      ).toBe((RENDER_PIPELINE_INPUTS as Record<string, string>)[pkg]);
    }
  });

  test("a fenced block is byte-identical to what the browser's CodeBlock would inject", async () => {
    // The structural comparison collapses code blocks to one marker, so the
    // highlighting itself needs its own check. This is a **byte** comparison
    // against the HTML the browser path produces: the same `shiki` entry point,
    // the same themes, the same `defaultColor: false`, the same language set —
    // so a theme, option or engine change fails here rather than silently
    // repainting the first paint.
    //
    // (The previous version of this test only compared the colour tokens and
    // the theme pair. Review pointed out the claim was stronger than the check,
    // MUL-439 `cmt_u0bywkppcajq`; this closes that gap.)
    const { codeToHtml } = await import("shiki");
    const fixtures: Array<[string, string]> = [
      ["typescript", "const answer: number = 42;\nexport default answer;\n"],
      ["python", "def f(x: int) -> str:\n    return str(x)\n"],
      ["bash", "set -euo pipefail\necho ok\n"],
      ["sql", "SELECT a, b FROM t WHERE a = 1 ORDER BY b DESC;\n"],
      ["json", '{"a": [1, 2], "b": null}\n'],
      ["yaml", "a: 1\nb:\n  - x\n"],
      ["go", 'func main() { fmt.Println("hi") }\n'],
      ["diff", "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n"],
      ["text", "no grammar, plain text\n"],
    ];
    for (const [lang, code] of fixtures) {
      const expected = await codeToHtml(code, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      });
      const server = renderMarkdown(`\`\`\`${lang}\n${code}\`\`\``);
      // The renderer emits the Shiki `<pre>` as the block's markup, so the
      // browser's own highlighting output must appear in it exactly once,
      // character for character.
      expect(
        server.html.includes(expected),
        `${lang}: rendered fence is not byte-identical to the browser's Shiki output\n` +
          `server: ${server.html.slice(0, 400)}\nexpected: ${expected.slice(0, 400)}`,
      ).toBe(true);
      expect(server.html.split(expected)).toHaveLength(2);
    }
  });

  test("the highlight comparison is not vacuous: the expected HTML is non-trivial", async () => {
    // Guards the test above from passing if Shiki started returning a bare
    // `<pre>`. Each expectation has to carry per-token colours for both themes.
    const { codeToHtml } = await import("shiki");
    const expected = await codeToHtml("const a: number = 1;\n", {
      lang: "typescript",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    expect(expected).toContain("shiki-themes github-light github-dark");
    expect(expected.match(/--shiki-light:#[0-9A-Fa-f]{6}/gu)?.length ?? 0).toBeGreaterThan(1);
    expect(expected.match(/--shiki-dark:#[0-9A-Fa-f]{6}/gu)?.length ?? 0).toBeGreaterThan(1);
  });

  test("a fence past 64 KiB is downgraded to a plain <pre>", () => {
    // Acceptance criterion from the MUL-439 description; also asserted on the
    // fixture path, but stated here on its own so the threshold itself is
    // pinned rather than the one sample.
    const justUnder = "x".repeat(64 * 1024 - 1);
    const justOver = "y".repeat(64 * 1024 + 1);
    expect(renderMarkdown(`\`\`\`text\n${justUnder}\n\`\`\``).downgraded).toBe(false);
    const over = renderMarkdown(`\`\`\`text\n${justOver}\n\`\`\``);
    expect(over.downgraded).toBe(true);
    expect(over.html).toContain("<pre>");
    expect(over.html).not.toContain("shiki");
  });

  test("SANITIZE_SCHEMA is equal to the frontend's exported schema", () => {
    // The server carries a copy of the schema because `packages/server` may not
    // import `frontend/packages/ui` (see the workspace-alias allowlist in
    // tests/arch/package-boundaries.test.ts). A behavioural test over hostile
    // inputs only covers the attributes it happens to exercise, so this asserts
    // the whole structure — including the regex whitelists, which a deep-equal
    // therefore has to compare as regexes rather than as opaque objects.
    //
    // Drift here is a real risk both ways: a protocol the frontend adds would be
    // stripped from `body_html`, and an attribute the server adds would let the
    // client render something the client itself would have removed.
    const frontend = FRONTEND_MD.sanitizeSchema;
    expect(frontend, "frontend Markdown.tsx must export sanitizeSchema").toBeDefined();
    expect(normalizeSchema(SANITIZE_SCHEMA)).toEqual(normalizeSchema(frontend));
  });

  test("SANITIZE_SCHEMA keeps the two internal protocols and the card attributes", () => {
    // Guards the test above from passing vacuously if both sides were emptied.
    expect(SANITIZE_SCHEMA.protocols?.href).toEqual(
      expect.arrayContaining(["mention", "slash", "http", "https"]),
    );
    expect(SANITIZE_SCHEMA.attributes?.div).toEqual(
      expect.arrayContaining(["dataType", "dataHref", "dataFilename"]),
    );
    const codeRules = SANITIZE_SCHEMA.attributes?.code ?? [];
    const codeClassNames = codeRules
      .filter((rule): rule is [string, RegExp] => Array.isArray(rule))
      .map(([, pattern]) => String(pattern));
    expect(codeClassNames).toContain(String(/^language-/));
    expect(codeClassNames).toContain(String(/^math-/));
    // And the schema still has the GitHub base underneath it.
    expect(SANITIZE_SCHEMA.tagNames).toContain("table");
    expect(SANITIZE_SCHEMA.tagNames).not.toContain("script");
  });

  test("the sanitize schema and the frontend's agree on a hostile input", () => {
    // Pins the two schema copies together behaviourally, which a version check
    // cannot: dropping one protocol or one attribute whitelist would only show
    // up on an input that exercises it.
    const hostile = [
      '<a href="mention://issue/iss_123">m</a>',
      '<a href="slash://skill/skill_1">s</a>',
      '<div data-type="fileCard" data-href="/uploads/a.pdf" data-filename="a.pdf"></div>',
      '<img src="https://x.test/a.png" alt="pic">',
      "<script>alert(1)</script>",
      '<img src="x" onerror="alert(1)">',
    ].join("\n");
    const server = renderMarkdown(hostile);
    expect(server.html).toContain('href="mention://issue/iss_123"');
    expect(server.html).toContain('href="slash://skill/skill_1"');
    expect(server.html).toContain('data-type="fileCard"');
    expect(server.html).toContain('alt="pic"');
    expect(server.html).not.toContain("<script");
    expect(server.html).not.toContain("onerror");
  });
});
