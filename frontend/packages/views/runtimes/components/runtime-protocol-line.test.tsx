import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import zhRuntimes from "../../locales/zh-Hans/runtimes.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { RuntimeProtocolLine } from "./runtime-protocol-line";

afterEach(cleanup);
const runtime = { runtime_mode: "local", protocol: { version: 1, state: "upgrade_failed", min_version: "0.2.83", last_error: "Permission denied" } } as AgentRuntime;

describe("runtime protocol status line", () => {
  it("shows exactly the shared CLI failure wording and retains the full long error in a title", () => {
    render(<I18nProvider resources={{ "zh-Hans": { runtimes: zhRuntimes } }} locale="zh-Hans"><RuntimeProtocolLine runtime={runtime} /></I18nProvider>);
    const line = screen.getByText("协议 v1 · 升级失败：Permission denied");
    expect(line).toHaveAttribute("title", "协议 v1 · 升级失败：Permission denied");
    expect(line).toHaveClass("truncate");
  });
  it("uses translated labels without changing the shared state formatter", () => {
    render(<I18nProvider resources={{ en: { runtimes: enRuntimes } }} locale="en"><RuntimeProtocolLine runtime={runtime} /></I18nProvider>);
    expect(screen.getByText("Protocol v1 · Upgrade failed: Permission denied")).toBeInTheDocument();
  });
  it("does not add a line for legacy missing fields or cloud runtimes", () => {
    const result = render(<RuntimeProtocolLine runtime={{ runtime_mode: "local" } as AgentRuntime} />);
    expect(result.container).toBeEmptyDOMElement();
    result.rerender(<RuntimeProtocolLine runtime={{ ...runtime, runtime_mode: "cloud" }} />);
    expect(result.container).toBeEmptyDOMElement();
  });
});
