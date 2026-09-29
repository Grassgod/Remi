import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { resolveCachedChromium } from "../../../../frontend/scripts/perf/lib/harness";

const html = resolve(import.meta.dir, "../../MUL-472-r4-report.html");
const browser = await chromium.launch({ executablePath: resolveCachedChromium() || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.goto(`file://${html}`);
    assert.equal(await page.locator("#observers tbody tr").count(), 167);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `/tmp/MUL-472-r4-report-${width}.png` });
    await page.locator("#search").fill("task-messages");
    assert.equal(await page.locator("#observers tbody tr:visible").count(), 4);
  }
  const download = page.waitForEvent("download");
  await page.locator("#download").click();
  const evidence = await download;
  await evidence.saveAs("/tmp/MUL-472-r4-evidence.json");
  const raw = JSON.parse(readFileSync("/tmp/MUL-472-r4-evidence.json", "utf8"));
  assert.equal(raw.after.results.length, 16);
  assert.equal(raw.afterLong.results.length, 2);
  assert.equal(raw.audit.observers.length, 167);
  assert.equal(raw.audit.sources.length, 170);
  await page.setContent('<iframe sandbox="allow-scripts" style="width:100%;height:800px;border:0"></iframe>');
  await page.locator("iframe").evaluate((frame, content) => { (frame as HTMLIFrameElement).srcdoc = content; }, readFileSync(html, "utf8"));
  const frame = page.frameLocator("iframe");
  await frame.locator("#search").fill("task-messages");
  assert.equal(await frame.locator("#observers tbody tr:visible").count(), 4);
  assert.deepEqual(errors, []);
  console.log("HTML desktop/mobile/sandbox: 167 observers, no overflow or script errors; raw download: 16+2 rounds / 170 sources");
} finally {
  await browser.close();
}
