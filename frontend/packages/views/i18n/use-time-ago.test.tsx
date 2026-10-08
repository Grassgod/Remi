import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import common from "../locales/en/common.json";
import { HydrationTimeProvider } from "./hydration-time";
import { useTimeAgo } from "./use-time-ago";

afterEach(() => vi.restoreAllMocks());

it.each([
  [60_000, "1m ago"],
  [3_600_000, "1h ago"],
  [86_400_000, "1d ago"],
])("hydrates across the %i ms relative-time boundary without replacing the image", async (boundary, expected) => {
  const now = vi.spyOn(Date, "now").mockReturnValue(boundary - 1);
  function Row() {
    const timeAgo = useTimeAgo();
    return <div><span>{timeAgo(new Date(0).toISOString())}</span><img src="/attachment.png" /></div>;
  }
  const tree = <HydrationTimeProvider now={boundary - 1}>
    <I18nProvider locale="en" resources={{ en: { common } }}><Row /></I18nProvider>
  </HydrationTimeProvider>;
  const container = document.createElement("div");
  container.innerHTML = renderToString(tree);
  document.body.append(container);
  const image = container.querySelector("img");
  now.mockReturnValue(boundary + 1);
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, tree, { onRecoverableError: error => errors.push(error) }); });
    expect(errors).toEqual([]);
    expect(container.querySelector("img")).toBe(image);
    expect(container.querySelector("span")?.textContent).toBe(expected);
  } finally {
    await act(async () => root?.unmount());
    container.remove();
  }
});

it("keeps a mounted formatter on the live clock after hydration", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(59_999);
  const { result } = renderHook(() => useTimeAgo(), { wrapper: ({ children }) => (
    <HydrationTimeProvider now={0}>
      <I18nProvider locale="en" resources={{ en: { common } }}>{children}</I18nProvider>
    </HydrationTimeProvider>
  ) });
  const formatter = result.current;
  expect(formatter(new Date(0).toISOString())).toBe("just now");
  now.mockReturnValue(60_001);
  expect(formatter(new Date(0).toISOString())).toBe("1m ago");
});
