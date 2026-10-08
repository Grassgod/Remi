import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";

/** Real layout, after the first-screen recorder has finished. Uses synthetic local Issues. */
export async function assertIssueDetailLayout(page: Page) {
  const measurements = [];
  const root = page.locator('[data-perf-scroll="issue-detail"]');
  const bar = page.locator("[data-agent-live-card]");
  const settle = () => page.evaluate(() => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await bar.waitFor({ state: "visible" });
    await root.evaluate(element => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
      element.scrollTop = 0;
    });
    await settle();
    const initial = await root.evaluate(element => {
      const card = element.querySelector<HTMLElement>("[data-agent-live-card]")!;
      const comment = element.querySelector<HTMLElement>("[data-issue-comment]")!;
      const divider = element.querySelector<HTMLElement>("[data-issue-activity-divider]")!;
      const nextContent = card.nextElementSibling as HTMLElement;
      const style = getComputedStyle(comment);
      return {
        barOffset: card.getBoundingClientRect().top - element.getBoundingClientRect().top,
        gap: nextContent.getBoundingClientRect().top - card.getBoundingClientRect().bottom,
        commentBorder: parseFloat(style.borderTopWidth),
        commentRadius: parseFloat(style.borderTopLeftRadius),
        dividerBorder: parseFloat(getComputedStyle(divider).borderTopWidth),
        containingRow: Boolean(card.closest('[data-perf-item="message"]')),
        reservedSlot: Boolean(element.querySelector("[data-agent-card-slot]")),
        horizontalOverflow: element.scrollWidth > element.clientWidth,
      };
    });
    assert(!initial.containingRow && !initial.reservedSlot, "execution bar must span the log, with no fixed reservation");
    assert(initial.commentBorder > 0 && initial.commentRadius > 0 && initial.dividerBorder > 0,
      "comment cards and the description/activity divider must have visible boundaries");
    assert(initial.gap >= 0 && initial.gap <= 40, `unexpected empty space below execution bar: ${initial.gap}px`);
    assert(!initial.horizontalOverflow, "Issue content must fit the viewport");

    const pinned = [];
    for (const extra of [120, 360]) {
      await root.evaluate((element, top) => { element.scrollTop = top; }, initial.barOffset + extra);
      await settle();
      pinned.push(await root.evaluate(element => {
        const card = element.querySelector<HTMLElement>("[data-agent-live-card]")!;
        const rect = card.getBoundingClientRect(), viewport = element.getBoundingClientRect();
        return { scrollTop: element.scrollTop, top: rect.top - viewport.top,
          bottom: rect.bottom - viewport.top, viewportHeight: element.clientHeight,
          buttons: [...card.querySelectorAll("button")].filter(button => button.getBoundingClientRect().width > 0).length };
      }));
    }
    assert(pinned[1]!.scrollTop - pinned[0]!.scrollTop > 100, "fixture must actually scroll past the description");
    assert(pinned.every(sample => Math.abs(sample.top - 16) < 1), "execution bar must remain 16px below the scroll viewport top");
    assert(pinned.every(sample => sample.bottom < sample.viewportHeight && sample.buttons > 0), "execution controls must stay visible");
    const toggle = bar.locator("button[aria-expanded]").first();
    await toggle.click();
    await settle();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    const expanded = await root.evaluate(element => {
      const rect = element.querySelector<HTMLElement>("[data-agent-live-card]")!.getBoundingClientRect();
      return { top: rect.top - element.getBoundingClientRect().top, height: rect.height,
        viewportHeight: element.clientHeight };
    });
    assert(Math.abs(expanded.top - 16) < 1 && expanded.height < expanded.viewportHeight,
      "expanded tasks must remain in the floating bar and fit the viewport");
    await toggle.click();
    const screenshotDir = process.env.MUL394_ZERO_JUMP_SHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await settle();
      const size = viewport.width < 600 ? "mobile" : "desktop";
      await page.screenshot({ path: join(screenshotDir, `issue-layout-${size}-sticky.png`) });
      await root.evaluate(element => { element.scrollTop = 0; });
      await settle();
      await page.screenshot({ path: join(screenshotDir, `issue-layout-${size}-overview.png`) });
    }
    measurements.push({ viewport, initial, pinned, expanded });
  }
  return measurements;
}
