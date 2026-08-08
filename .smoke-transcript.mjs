// Throwaway smoke: does the per-reply transcript button render on the live site?
import { chromium } from "playwright";

const TOKEN = process.env.SMOKE_TOKEN;
const URL = "http://127.0.0.1:3000/remi/issues/iss_2t4rzzc4ypoj";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript((t) => localStorage.setItem("multimira_token", t), TOKEN);
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)); });
page.on("response", (r) => { if (r.status() >= 400) console.log("[http]", r.status(), r.url().slice(0, 120)); });

await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);

const comments = await page.locator('[class*="group/msg"], [data-slot="comment"]').count();
const byTooltip = await page.locator('button[title*="查看执行记录"], [title*="查看执行记录"]').count();
const anyTranscript = await page.locator('button[title*="执行"], button[title*="记录"]').count();
const bodyHasSong = (await page.content()).includes("Remi 小调");
console.log(JSON.stringify({ comments, transcriptButtons: byTooltip, anyTranscriptish: anyTranscript, songCommentRendered: bodyHasSong }));
await page.screenshot({ path: "/tmp/transcript-smoke.png", fullPage: false });
await browser.close();
