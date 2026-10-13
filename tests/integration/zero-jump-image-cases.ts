/** Real PNG regressions for late decode / error after the first normal reveal. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Page } from "playwright-core";
import type { MultiremiStore } from "../../packages/server/src/store/store";
import type { ZeroJumpFixture } from "./zero-jump-fixture";

export interface ImageCase {
  key: string;
  issueId: string;
  commentId: string;
  attachmentId: string;
  kind: "late" | "error" | "element" | "sized" | "fast";
}

export async function seedImageCases(store: MultiremiStore, fixture: ZeroJumpFixture, uploadDir: string): Promise<ImageCase[]> {
  const png = await sharp({ create: { width: 640, height: 240, channels: 3, background: "blue" } }).png().toBuffer();
  return (["late", "error", "element", "sized", "fast"] as const).map(kind => {
    const key = `detail-image-${kind}`;
    const issue = store.createIssue({ id: `iss_zerojump_image_${kind}`, title: `Zero-jump image ${kind}`, status: "in_progress" });
    const session = store.getOrCreateDefaultIssueSession(issue.id, fixture.userId);
    for (let i = 0; i < 2; i++) store.createIssueComment(issue.id, {
      issueSessionId: session.id, authorType: "member", authorId: fixture.userId, body: `Image preamble ${i}`,
    });
    const attachmentId = `att_zerojump_image_${kind}`;
    store.createAttachment({ id: attachmentId, workspaceId: fixture.workspaceId, issueId: issue.id,
      uploaderType: "member", uploaderId: fixture.userId, filename: `${kind}.png`,
      url: `/api/attachments/${attachmentId}/content`, contentType: "image/png", sizeBytes: png.length });
    writeFileSync(join(uploadDir, fixture.workspaceId, `${attachmentId}.png`), png);
    const dimensions = kind === "sized" ? ' width="640" height="240"' : "";
    const comment = store.createIssueComment(issue.id, { issueSessionId: session.id,
      authorType: "member", authorId: fixture.userId,
      body: `Image regression\n\n<img src="/api/attachments/${attachmentId}/content" alt="Image regression"${dimensions}>\n\nImage footer anchor`,
    });
    return { key, issueId: issue.id, commentId: comment.id, attachmentId, kind };
  });
}

interface ImageSample {
  height: number;
  width: number;
  rowHeight: number;
  scrollHeight: number;
  scrollTop: number;
  anchorTop: number | null;
  complete: boolean;
  naturalWidth: number;
  loading: string;
}
export interface ImageObservation {
  kind: ImageCase["kind"];
  before: ImageSample | null;
  after: ImageSample;
}

async function sample(page: Page, imageCase: ImageCase): Promise<ImageSample> {
  return page.evaluate(({ attachmentId, kind }) => {
    const root = document.querySelector<HTMLElement>('[data-perf-scroll="issue-detail"]')!;
    const image = root.querySelector<HTMLImageElement>(`img[src*="${attachmentId}/content"]`)!;
    const rect = image.getBoundingClientRect();
    const anchor = root.querySelector(kind === "element" ? '[data-perf-anchor="target-comment"]' : '[data-perf-anchor="latest-comment"]');
    return { height: rect.height, width: rect.width, rowHeight: image.closest('[data-perf-key]')!.getBoundingClientRect().height,
      scrollHeight: root.scrollHeight, scrollTop: root.scrollTop, anchorTop: anchor?.getBoundingClientRect().top ?? null,
      complete: image.complete, naturalWidth: image.naturalWidth, loading: image.loading };
  }, imageCase);
}

export async function installImageBarrier(page: Page, imageCase: ImageCase) {
  let before: ImageSample | null = null;
  // A condition barrier, not a new fixture delay or reveal budget. The exact
  // HTTP request completes only after the app has normally revealed the row.
  await page.route(`**/api/attachments/${imageCase.attachmentId}/content`, async route => {
    if (imageCase.kind !== "fast") {
      await page.waitForFunction(() => document.querySelector('[data-perf-scroll="issue-detail"][data-perf-state="ready"][data-perf-fresh="1"]'));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      before = await sample(page, imageCase);
    }
    if (imageCase.kind === "error") await route.fulfill({ status: 404, body: "" });
    else await route.fallback();
  });
  return async (): Promise<ImageObservation> => ({ kind: imageCase.kind, before, after: await sample(page, imageCase) });
}

export function imageObservationFailure(observation: ImageObservation): string | null {
  const { kind, before, after } = observation;
  if (!after.complete || (kind === "error" ? after.naturalWidth !== 0 : after.naturalWidth !== 640)) return "real PNG / error response was not observed";
  if (after.loading !== "lazy") return "log image lost lazy loading";
  if (kind === "fast") return after.height > 0 ? null : "fast PNG has no reserved height";
  if (!before || before.complete || before.height <= 0) return "image was not held with a nonempty box at first normal reveal";
  // Assert image-caused layout growth exactly. Anchor / scroll motion uses the
  // existing S7 recorder and verdict, including SSR centering's pixel rounding.
  for (const key of ["height", "width", "rowHeight", "scrollHeight"] as const) {
    if (before[key] !== after[key]) return `image ${kind} changed ${key}: ${before[key]} -> ${after[key]}`;
  }
  return null;
}
