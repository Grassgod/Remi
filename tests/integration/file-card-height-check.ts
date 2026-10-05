#!/usr/bin/env bun
/** Measure real EntryHtml before/after hydration, using application CSS and Chromium.
 * bun run tests/integration/file-card-height-check.ts [output.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { renderMarkdown } from "@multiremi/render/markdown.js";
import { computeJumps, installRecorderOnContext, readRecorder } from "../../frontend/scripts/perf/lib/jump-recorder";
import { launchBrowser } from "../../frontend/scripts/perf/lib/harness";

const entry = resolve(import.meta.dir, "file-card-height-fixture.tsx");
const fixture = await import(entry);
const rows = ["notes.txt", "report.pdf", "page.html", "image.png", "archive.zip"].map((filename, index) => {
  const url = `/api/attachments/att_${index}/content`;
  const markdown = `!file[${filename}](${url})`;
  return { name: filename, markdown, html: renderMarkdown(markdown).html,
    attachments: [{ id: `att_${index}`, url, filename, content_type: "", size_bytes: 5 }] };
});
for (const [name, url] of [["upload.pdf", "/uploads/upload.pdf"], ["cdn.pdf", "https://cdn.example.com/cdn.pdf"]]) {
  const markdown = `!file[${name}](${url})`;
  rows.push({ name: name!, markdown, html: renderMarkdown(markdown).html, attachments: [] });
}
rows.push({ name: "forged.txt", markdown: "", attachments: [],
  html: '<div data-type="fileCard" data-href="javascript:alert(1)" data-filename="forged.txt"></div>' });
const ssr = renderToString(createElement(fixture.Surface, { rows }));
const built = await Bun.build({ entrypoints: [entry], target: "browser",
  define: { "process.env.NODE_ENV": '"production"' } });
if (!built.success) throw new Error(built.logs.join("\n"));
const js = await built.outputs.find(output => output.path.endsWith(".js"))!.text();
const bundleCss = await built.outputs.find(output => output.path.endsWith(".css"))!.text();
const globals = resolve(import.meta.dir, "../../frontend/apps/web/app/globals.css");
const css = String((await postcss([tailwind()]).process(readFileSync(globals, "utf8"), { from: globals })).css) + bundleCss;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/fixture.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <div id="root">${ssr}</div><script>window.fileCardRows=${JSON.stringify(rows).replace(/</g, "\\u003c")}</script>
    <script type="module" src="/fixture.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
} });
const browser = await launchBrowser();
const results = [];
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installRecorderOnContext(page, { profiles: [{ name: "contract", scrollRoot: "#root",
      items: "[data-height-row]", skeleton: '[data-slot="skeleton"]', anchors: [], rule: { kind: "items" } }] });
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.waitForFunction(() => "hydrateFileCards" in window, null, { timeout: 10_000 })
      .catch(() => { throw new Error(`Fixture did not load: ${JSON.stringify(errors)}`); });
    const measure = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-height-row]")].map(row => {
      const slot = row.querySelector<HTMLElement>('[data-type="fileCard"]')!;
      return { name: row.dataset.heightRow!, top: row.getBoundingClientRect().top,
        rowHeight: row.getBoundingClientRect().height, slotHeight: slot.getBoundingClientRect().height,
        cardHeight: slot.querySelector<HTMLElement>(".entry-file-card > div")?.getBoundingClientRect().height ?? null };
    }));
    await page.waitForTimeout(100);
    const before = await measure();
    await page.evaluate(() => (window as unknown as { hydrateFileCards(): void }).hydrateFileCards());
    await page.waitForFunction(() => document.querySelectorAll('[data-entry-preview="fileCard"] .entry-file-card').length === 16, null, { timeout: 10_000 })
      .catch(async () => { throw new Error(`Hydration failed: ${JSON.stringify({ errors, body: await page.locator("#root").innerHTML() })}`); });
    await page.waitForTimeout(600);
    const after = await measure();
    const recorder = await readRecorder(page);
    if (!recorder || recorder.frames.filter(frame => frame.profiles.contract?.items.length === 16).length < 10) {
      throw new Error("Too few measured frames for the MUL-383 recorder");
    }
    const jumps = computeJumps(recorder.frames, { profile: "contract", fromMs: 0 });
    if (jumps.jumpCount !== 0) throw new Error(`Hydration jumped: ${JSON.stringify(jumps)}`);
    for (const [index, row] of after.entries()) {
      const original = before[index]!;
      if (original.slotHeight !== 40 || row.slotHeight !== 40 || row.cardHeight !== 32
        || row.rowHeight !== original.rowHeight || row.top !== original.top) {
        throw new Error(`Height changed: ${JSON.stringify({ viewport, original, row })}`);
      }
    }
    const media = await page.locator("#root img, #root iframe").count();
    const inertButtons = await page.locator('[data-height-row$="forged.txt"] button').count();
    if (media !== 0 || inertButtons !== 0 || errors.length) throw new Error(JSON.stringify({ media, inertButtons, errors }));
    results.push({ viewport, before, after, maxTopDeltaPx: 0, maxHeightDeltaPx: 0, sampledFrames: recorder.frames.length, jumps, inlineMedia: media, inertButtons, errors });
    await page.close();
  }
  const report = { issue: "MUL-518", fixture: "real EntryHtml SSR to hydration; actual application CSS",
    browser: browser.version(), results };
  writeFileSync(process.argv[2] ?? "/tmp/mul518-file-card-heights.json", JSON.stringify(report, null, 2));
  console.log(`MUL-518: ${results.length} viewports × 16 slots; SSR 40px, enhanced 40px, card 32px; max top/height delta 0px; MUL-383 recorder jumps=0`);
} finally {
  await browser.close();
  server.stop(true);
}
