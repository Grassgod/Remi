import { describe, expect, it } from "vitest";
import { navigationRequestKind } from "./navigation-request";

describe("Issue navigation request classification", () => {
  it.each([
    [{}, "soft-nav"],
    [{ rsc: "1" }, "soft-nav"],
    [{ "next-router-prefetch": "1" }, "soft-nav"],
    [{ "next-router-segment-prefetch": "/_tree" }, "soft-nav"],
    [{ accept: "text/x-component" }, "soft-nav"],
    [{ accept: "*/*" }, "soft-nav"],
    [{ accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, "document"],
    [{ accept: "application/json" }, "soft-nav"],
    [{ "sec-fetch-dest": "document", accept: "*/*" }, "document"],
    [{ "sec-fetch-dest": "iframe" }, "document"],
    [{ "sec-fetch-dest": "empty", accept: "text/html" }, "soft-nav"],
    [{ purpose: "prefetch", accept: "text/html" }, "soft-nav"],
  ])("classifies request headers %j", (headers, expected) => {
    expect(navigationRequestKind(new Headers(headers as Record<string, string>))).toBe(expected);
  });
});
