/** Native browser regression for an image streamed through a hidden SSR buffer. */
import { writeFileSync } from "node:fs";
import { launchBrowser } from "../../frontend/scripts/perf/lib/harness";
import { deferStreamedImages } from "../../frontend/packages/views/common/session-log/image-loading";

const out = process.argv[process.argv.indexOf("--out") + 1];
if (!out) throw new Error("--out is required");
const browser = await launchBrowser();
const source = '<img src="https://image-fixture.invalid/one.png" alt="SSR image">';
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
async function probe(html: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let reads = 0;
  // Same routing/cache behavior as the S7 read-only guard, no trace or HAR.
  await context.route("https://image-fixture.invalid/one.png", async route => {
    reads += 1;
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  const page = await context.newPage();
  try {
    await page.setContent(`<div id="buffer" style="display:none">${html}</div><div id="placed" style="visibility:hidden"></div>`);
    if (!html.includes('loading="lazy"')) await page.waitForFunction(() => (document.querySelector("#buffer img") as HTMLImageElement).naturalWidth > 0);
    else await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const beforePlacement = reads;
    await page.evaluate(() => {
      const buffer = document.getElementById("buffer")!;
      document.getElementById("placed")!.innerHTML = buffer.innerHTML;
      buffer.remove();
    });
    await page.waitForFunction(() => (document.querySelector("#placed img") as HTMLImageElement).naturalWidth > 0);
    const dimensions = await page.locator("#placed img").evaluate(el => ({ width: (el as HTMLImageElement).naturalWidth, height: (el as HTMLImageElement).naturalHeight }));
    return { beforePlacement, totalReads: reads, dimensions };
  } finally { await context.close(); }
}
try {
  const before = await probe(source), after = await probe(deferStreamedImages(source)!);
  writeFileSync(out, JSON.stringify({ fixture: "hidden SSR buffer -> placed, visibility hidden until image load", before, after }, null, 2));
  if (before.beforePlacement !== 1 || before.totalReads !== 2 || after.beforePlacement !== 0 || after.totalReads !== 1
    || JSON.stringify(before.dimensions) !== JSON.stringify(after.dimensions)) throw new Error("SSR buffer image request invariant failed");
  console.log("SSR image buffer: eager 2 reads -> deferred 1, unchanged loaded image");
} finally { await browser.close(); }
