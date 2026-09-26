/**
 * The 20 representative markdown inputs for the `renderMarkdown` parity check.
 *
 * MUL-439 splits them by the features called out in the acceptance criteria:
 * fenced code (with and without a language), tables, math (inline and display),
 * mentions (both the modern link form and the legacy shortcode), inline HTML
 * (allowed, then hostile), oversized fences, and the ordinary prose that most
 * rows actually contain.
 *
 * They are data, not test code, so the parity test reads as one loop and the
 * list is easy to extend when a new rendering feature lands.
 */
export interface RenderFixture {
  name: string;
  markdown: string;
  cdnDomain?: string;
  /**
   * Skip the structural comparison. Set only where the two renderers are
   * *documented* to differ (the >64 KiB downgrade), so that any other
   * divergence fails the suite instead of being waved through.
   */
  skipStructureCompare?: boolean;
}

/** A fence comfortably past the 64 KiB downgrade threshold. */
const HUGE_CODE = `\`\`\`text\n${"const oversized = 1;\n".repeat(4000)}\`\`\``;

export const FIXTURES: RenderFixture[] = [
  {
    name: "01 plain prose",
    markdown: "A short sentence about the task.\n\nAnd a second paragraph.",
  },
  {
    name: "02 markdown link and emphasis",
    markdown: "See [the plan](https://example.com/plan) for **the details** and _context_.",
  },
  {
    name: "03 fenced code with a language",
    markdown: "```ts\nconst answer: number = 42;\nexport default answer;\n```",
  },
  {
    name: "04 fenced code without a language",
    markdown: "```\nno language here\nsecond line\n```",
  },
  {
    name: "05 fenced code in a language outside the server grammar set",
    markdown: "```haxe\nclass Main { static function main() {} }\n```",
  },
  {
    name: "06 table",
    markdown: "| Step | Owner | Status |\n| --- | --- | --- |\n| design | A | done |\n| build | C | wip |",
  },
  {
    name: "07 task list",
    markdown: "- [x] fetch the branch\n- [ ] open the Draft PR\n- [ ] reply on the issue",
  },
  {
    name: "08 inline math",
    markdown: "The bound is $O(n \\log n)$ for this input.",
  },
  {
    name: "09 display math",
    markdown: "$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$",
  },
  {
    name: "10 mention link",
    markdown: "Ping [@Design设计师](mention://agent/agt_73qwsj3w60ue) about the prototype.",
  },
  {
    name: "11 legacy mention shortcode",
    markdown: '[@ id="agt_73qwsj3w60ue" label="Design设计师"] please review the copy.',
  },
  {
    name: "12 slash command link",
    markdown: "Run [deploy](slash://skill/skill-abc123) when the branch is green.",
  },
  {
    name: "13 bare URL and file path linkification",
    markdown: "Logs are at /data00/home/hehuajie/remi.log and the build is https://ci.example.com/build/42",
  },
  {
    name: "14 allowed inline HTML",
    markdown: "Before <code>uv run pytest -q</code> and <br> after a hard break.",
  },
  {
    name: "15 hostile inline HTML is sanitized",
    markdown: '<script>steal()</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>',
  },
  {
    name: "16 blockquote and heading",
    markdown: "## Decision\n\n> Ship the read pool first, then wire the window endpoint.",
  },
  {
    name: "17 strikethrough and inline code",
    markdown: "~~obsolete~~ replaced by `readPool.query(...)`.",
  },
  {
    name: "18 mixed CJK URL boundary",
    markdown: "参考 https://example.com/spec。后面还有一句中文说明。",
  },
  {
    name: "19 file card",
    markdown: "!file[report.pdf](/uploads/2026/09/report.pdf)",
  },
  {
    name: "20 oversized fence above 64 KiB",
    markdown: HUGE_CODE,
    skipStructureCompare: true,
  },
];
