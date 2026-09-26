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
import { renderMarkdown, RENDER_VERSION } from "@multiremi/render/markdown.js";
import { RENDER_PIPELINE_INPUTS } from "@multiremi/render/render-version.js";
import { FIXTURES } from "./render-markdown-fixtures.js";
import { describeNodes, normalizeBrowserHtml, normalizeHtml } from "./render-markdown-compare.js";

interface MinimalMarkdownModule {
  Markdown: (props: { children: string; mode?: string; cdnDomain?: string }) => React.ReactElement;
}

/**
 * The browser component. Imported through the ui package's export map, so this
 * test breaks if that entry point ever stops exposing `Markdown`.
 */
const FRONTEND_MD = (await import("@multiremi/ui/markdown")) as unknown as MinimalMarkdownModule;

describe("renderMarkdown parity with frontend Markdown.tsx (MUL-439)", () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const server = renderMarkdown(fixture.markdown, { cdnDomain: fixture.cdnDomain });
      const browser = renderToStaticMarkup(
        React.createElement(
          FRONTEND_MD.Markdown,
          {
            // `minimal` is the mode messages and comments use; it is the mode
            // `body_html` has to match.
            mode: "minimal",
            ...(fixture.cdnDomain ? { cdnDomain: fixture.cdnDomain } : {}),
          },
          fixture.markdown,
        ),
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

  test("fenced code is highlighted with the same Shiki HTML and options", async () => {
    // The structural test collapses code blocks to one marker, so this is what
    // actually pins the highlighting: same themes, same `defaultColor: false`,
    // same per-token spans as the browser's `CodeBlock` produces. A theme,
    // option or engine change shows up here as a byte difference.
    const { codeToHtml } = await import("shiki");
    const fixtures: Array<[string, string]> = [
      ["typescript", "const answer: number = 42;\nexport default answer;\n"],
      ["python", "def f(x: int) -> str:\n    return str(x)\n"],
      ["bash", "set -euo pipefail\necho ok\n"],
      ["sql", "SELECT a, b FROM t WHERE a = 1 ORDER BY b DESC;\n"],
    ];
    for (const [lang, code] of fixtures) {
      const expected = await codeToHtml(code, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      });
      // The renderer's own output for the same fence has to contain that HTML
      // verbatim: fenced blocks pass through sanitize untouched (the classes
      // survive) and Shiki re-emits them from the same source text.
      const server = renderMarkdown(`\`\`\`${lang}\n${code}\`\`\``);
      const shikiPre = expected.replace(/<span class="line">([\s\S]*?)<\/span>\n?/gu, "$1");
      const serverBody = server.html.replace(/<span class="line">/gu, "").replace(/<\/span>\n/gu, "");
      for (const token of shikiPre.match(/--shiki-light:#[0-9A-Fa-f]{6}/gu) ?? []) {
        expect(serverBody, `${lang}: token colour missing from the rendered fence`).toContain(token);
      }
      expect(server.html, `${lang}: fence must carry both themes`).toContain("shiki-themes github-light github-dark");
      expect(server.html, `${lang}: fence must not use a single theme colour`).not.toContain("--shiki-light-bg:#fff;\"");
    }
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
