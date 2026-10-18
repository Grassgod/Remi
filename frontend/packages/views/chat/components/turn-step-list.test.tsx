import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { TraceItem } from "@multiremi/contracts/trace";
import { renderWithI18n } from "../../test/i18n";
import {
  change, command, fileChange, listFiles, message, notice, read, search, subagent, tool, unknown, webSearch,
} from "../../test/trace-fixtures";
import { displayCommand } from "../../common/task-transcript/trace-item-detail";
import { buildTurnSteps } from "../lib/turn-steps";
import { TurnStepList } from "./turn-step-list";

const { copied } = vi.hoisted(() => ({ copied: vi.fn().mockResolvedValue(true) }));
vi.mock("@multiremi/ui/lib/clipboard", () => ({ copyText: copied }));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));

function renderSteps(items: TraceItem[], locale: "zh-Hans" | "en" = "zh-Hans") {
  return renderWithI18n(<TurnStepList steps={buildTurnSteps(items)} items={items} />, { locale });
}
const row = (key: string) => document.querySelector<HTMLElement>(`[data-step-row="${key}"]`)!;
const trigger = (element: Element) => element.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!;

/** jsdom lays nothing out: elements carrying `attribute` report `client` px of box over `scroll` px of content. */
function mockBox(attribute: string, size: { scroll: number; client: number }) {
  for (const [name, value] of [["scrollHeight", size.scroll], ["clientHeight", size.client]] as const) {
    const inherited = Object.getOwnPropertyDescriptor(Element.prototype, name)!.get!;
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true,
      get(this: HTMLElement) { return this.hasAttribute(attribute) ? value : inherited.call(this); } });
  }
}
afterEach(() => {
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

describe("steps", () => {
  it("folds a run of rows under a collapsed summary and expands it on click", () => {
    renderSteps([command("cmd_1", [read("src/a.ts"), search("todo", "src")]), command("cmd_2", [unknown("bun test")])]);
    const group = document.querySelector("[data-step-group]")!;
    expect(trigger(group)).toHaveTextContent("已读取文件，运行了命令");
    expect(trigger(group)).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger(group));
    expect(within(group as HTMLElement).getByText("已读取 a.ts")).toBeInTheDocument();
    expect(within(group as HTMLElement).getByText("已在 src 中搜索“todo”")).toBeInTheDocument();
    expect(within(group as HTMLElement).getByText("已运行 bun test")).toBeInTheDocument();
  });

  it("joins summary fragments with the en separator and lower-cases the later ones", () => {
    renderSteps([fileChange("fc_1", [change("a.ts")]), command("cmd_1", [unknown("make")]), webSearch("ws_1", "acp")], "en");
    expect(trigger(document.querySelector("[data-step-group]")!)).toHaveTextContent("Edited a file, ran a command, searched the web");
  });

  it("renders commentary at body size between runs and a lone row on its own", () => {
    renderSteps([command("cmd_1", [read("a.ts")]), message("msg:1", "Looking at the tests next."), command("cmd_2", [unknown("bun test")])]);
    expect(document.querySelector("[data-step-message]")).toHaveTextContent("Looking at the tests next.");
    expect(document.querySelectorAll("[data-step-group]")).toHaveLength(0);
    expect(row("cmd_1:0")).toHaveTextContent("已读取 a.ts");
  });

  it("shows a file's line counts and its diff, at most 240px", () => {
    renderSteps([fileChange("fc_1", [{ ...change("src/app.ts"), diff: "@@\n context\n-old\n+new\n+more", added: 2, removed: 1 }])]);
    expect(row("fc_1:0")).toHaveTextContent("已编辑 app.ts+2-1");
    fireEvent.click(trigger(row("fc_1:0")));
    const diff = document.querySelector("[data-diff-detail]")!;
    expect(diff).toHaveTextContent("src/app.ts");
    expect(diff.querySelector("pre")!.className).toContain("max-h-60");
    expect(within(diff as HTMLElement).getByText("+new").className).toContain("text-emerald");
    expect(within(diff as HTMLElement).getByText("-old").className).toContain("text-red");
  });

  it("explains a missing diff", () => {
    renderSteps([fileChange("fc_1", [{ ...change("big.json"), diff: null, diff_truncated: true, added: 9, removed: 0 }])]);
    fireEvent.click(trigger(row("fc_1:0")));
    expect(screen.getByText("差异内容过多，无法预览")).toBeInTheDocument();
  });

  it("draws a subagent as one line, name · task, with its own steps kept for the panel (PR 5 §6.2)", () => {
    renderSteps([
      subagent("sub_1", "Explore", { name: "Explore", prompt: "## Find the **loader**\nthen report", output: "Loader is in config.ts" }),
      command("cmd_c", [read("config.ts")], { parent_id: "sub_1" }),
    ]);
    const row = document.querySelector<HTMLButtonElement>('[data-subagent-row="sub_1"]')!;
    expect(row).toHaveTextContent("Explore · Find the loader");
    expect(row).toHaveAccessibleName("打开子代理 Explore");
    // No inline expansion: the child steps and the report live in the panel.
    expect(screen.queryByText("已读取 config.ts")).toBeNull();
    expect(screen.queryByText("Loader is in config.ts")).toBeNull();
    // Outside a turn with an attempt (no trace source) the row opens nothing.
    expect(row).toBeDisabled();
  });

  it("shows a background subagent as running in the background, without live activity (spec §13)", () => {
    renderSteps([subagent("sub_bg", "Count files", { status: "in_progress", completed_at: null, background: true }),
      command("cmd_c", [read("a.ts")], { parent_id: "sub_bg", status: "in_progress", completed_at: null })]);
    const row = document.querySelector('[data-subagent-row="sub_bg"]')!;
    expect(row.querySelector("[data-subagent-status-text]")).toHaveAttribute("data-subagent-status-text", "background");
    expect(row).toHaveTextContent("后台运行中");
    expect(row).not.toHaveTextContent("正在读取");
  });

  it("opens a message control row to the message it sent (PR 5 §6.2)", () => {
    renderSteps([subagent("sa:a1", "Explore", { name: "Explore", thread_id: "a1" }),
      tool("t_msg", "SendMessage", { input: { to: "a1", message: "Also check the **tests**" } })]);
    expect(row("t_msg")).toHaveTextContent("已发送消息给 Explore");
    fireEvent.click(trigger(row("t_msg")));
    const detail = document.querySelector("[data-agent-message]")!;
    expect(detail).toHaveTextContent("发给 Explore");
    expect(detail).toHaveTextContent("Also check the **tests**");
  });

  it("marks an error notice", () => {
    renderSteps([notice("ntc:1", "Rate limited", "error")]);
    expect(trigger(document.querySelector('[data-step-breaker="ntc:1"]')!).className).toContain("text-destructive");
  });

  it("lifts the group's 224px cap and fades while a row is open, then restores its scroll position", () => {
    renderSteps([command("cmd_1", [unknown("ls")], { output: "a.txt" }), command("cmd_2", [unknown("pwd")], { output: "/w" })]);
    const group = document.querySelector<HTMLElement>("[data-step-group]")!;
    fireEvent.click(trigger(group));
    const list = group.querySelector<HTMLElement>("[data-fade-scroll]")!;
    // The clipping panel carries the list's 8px gutter, so focus rings and the scrollbar show whole.
    expect(list.parentElement!.className.split(/\s+/)).toEqual(expect.arrayContaining(["-mx-2", "px-2"]));
    expect(list).toHaveAttribute("data-fade-scroll", "capped");
    expect(list.className).toContain("max-h-56");
    list.scrollTop = 80;
    fireEvent.scroll(list);
    fireEvent.click(trigger(row("cmd_2:0")));
    expect(list).toHaveAttribute("data-fade-scroll", "lifted");
    expect(list.className).toContain("max-h-none");
    expect(list.className).not.toContain("max-h-56");
    expect(list.style.maskImage).toBe("");
    // The browser clamps the position once the cap is gone; closing the row brings it back.
    list.scrollTop = 0;
    fireEvent.click(trigger(row("cmd_2:0")));
    expect(list).toHaveAttribute("data-fade-scroll", "capped");
    expect(list.scrollTop).toBe(80);
  });

  it("draws an open row at the foreground colour, unlike its muted neighbours", () => {
    renderSteps([command("cmd_1", [unknown("ls")], { output: "a.txt" }), command("cmd_2", [unknown("pwd")], { output: "/w" })]);
    fireEvent.click(trigger(document.querySelector("[data-step-group]")!));
    const open = trigger(row("cmd_1:0"));
    fireEvent.click(open);
    expect(open).toHaveAttribute("data-panel-open");
    expect(open.className).toContain("data-[panel-open]:text-foreground");
    expect(trigger(row("cmd_2:0"))).not.toHaveAttribute("data-panel-open");
  });
});

describe("command detail", () => {
  it("clamps the command to two lines with 展开 / 收起 and keeps its wrapped output at most 144px", () => {
    const script = "bun run test \\\n  --filter views \\\n  --reporter dot";
    mockBox("data-command-text", { scroll: 60, client: 40 });
    renderSteps([command("cmd_1", [unknown(script)], { output: "line 1\nline 2\n✓ done" })]);
    fireEvent.click(trigger(row("cmd_1:0")));
    const detail = document.querySelector<HTMLElement>("[data-command-detail]")!;
    const commandText = detail.querySelector<HTMLElement>("[data-command-text]")!;
    expect(commandText.textContent).toBe(script);
    expect(commandText).not.toHaveAttribute("title");
    const classes = () => commandText.className.split(/\s+/);
    // `block` would override the clamp's display, so the two never coexist.
    expect(classes()).toContain("line-clamp-2");
    expect(classes()).not.toContain("block");
    const toggle = screen.getByRole("button", { name: "展开" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", commandText.id);
    expect(toggle.className).toContain("cursor-pointer");
    fireEvent.click(toggle);
    expect(classes()).toContain("block");
    expect(classes()).not.toContain("line-clamp-2");
    expect(toggle).toHaveTextContent("收起");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(classes()).toContain("line-clamp-2");
    const output = detail.querySelector<HTMLElement>("[data-command-output]")!;
    expect(output.className).toContain("max-h-36");
    expect(output.className).toContain("text-[13px]");
    // Long lines wrap instead of running off the right edge.
    expect(output.className.split(/\s+/)).toEqual(expect.arrayContaining(["whitespace-pre-wrap", "break-words"]));
    expect(output.className.split(/\s+/)).not.toContain("whitespace-pre");
    expect(detail.querySelector("[data-command-status]")).toHaveTextContent("成功");
  });

  it("offers no expand control for a command that fits in two lines", () => {
    mockBox("data-command-text", { scroll: 20, client: 20 });
    renderSteps([command("cmd_1", [unknown("ls -la")], { output: "total 0" })]);
    fireEvent.click(trigger(row("cmd_1:0")));
    expect(screen.queryByRole("button", { name: "展开" })).toBeNull();
    expect(document.querySelector("[data-command-detail] [aria-expanded]")).toBeNull();
  });

  it("opens a finished command's output at the top", () => {
    mockBox("data-command-output", { scroll: 500, client: 144 });
    renderSteps([command("cmd_1", [unknown("cat big.log")], { output: "1\n2\n3" })]);
    fireEvent.click(trigger(row("cmd_1:0")));
    expect(document.querySelector<HTMLElement>("[data-command-output]")!.scrollTop).toBe(0);
  });

  it("follows a running command's output until the reader scrolls up", () => {
    mockBox("data-command-output", { scroll: 500, client: 144 });
    const running = (output: string) => [command("cmd_1", [unknown("tail -f app.log")], { status: "in_progress", completed_at: null, output })];
    const items = running("1\n2");
    const view = renderSteps(items);
    fireEvent.click(trigger(row("cmd_1:0")));
    const output = () => document.querySelector<HTMLElement>("[data-command-output]")!;
    expect(output().scrollTop).toBe(500);
    output().scrollTop = 100;
    fireEvent.scroll(output());
    const next = running("1\n2\n3");
    view.rerender(<TurnStepList steps={buildTurnSteps(next)} items={next} />);
    expect(output()).toHaveTextContent("3");
    expect(output().scrollTop).toBe(100);
  });

  it.each([
    [{ status: "failed" as const, exit_code: 2 }, "退出码 2"],
    [{ status: "stopped" as const, exit_code: null }, "已停止"],
    [{ status: "failed" as const, exit_code: null }, "退出码未知"],
  ])("reads a failed command as 已运行 and puts %j in the footer", (overrides, footer) => {
    renderSteps([command("cmd_1", [unknown("bun test")], overrides)]);
    if (overrides.status === "failed") expect(row("cmd_1:0")).toHaveTextContent("已运行 bun test");
    fireEvent.click(trigger(row("cmd_1:0")));
    expect(document.querySelector("[data-command-status]")).toHaveTextContent(footer);
  });

  it("labels a titled command with its title and keeps the whole command in the detail (spec §13)", () => {
    renderSteps([command("cmd_t", [unknown("sleep 25"), listFiles("/w")], { title: "Sleep 25s then list directory", output: "a.txt" })], "en");
    expect(row("cmd_t:0")).toHaveTextContent("Sleep 25s then list directory");
    expect(document.querySelector('[data-step-row="cmd_t:1"]')).toBeNull();
    fireEvent.click(trigger(row("cmd_t:0")));
    const detail = document.querySelector<HTMLElement>("[data-command-detail]")!;
    expect(detail.querySelector("[data-command-text]")).toHaveTextContent("sleep 25 && ls");
    expect(detail.querySelector("[data-command-output]")).toHaveTextContent("a.txt");
  });

  it("says 无输出 and copies the command and the output from their own blocks", async () => {
    const { unmount } = renderSteps([command("cmd_1", [unknown("true")], { output: null })]);
    fireEvent.click(trigger(row("cmd_1:0")));
    expect(screen.getByText("无输出")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制输出" })).toBeNull();
    unmount();
    renderSteps([command("cmd_2", [unknown("bash -lc 'ls -la'")], { command: "bash -lc 'ls -la'", output: "total 0" })]);
    fireEvent.click(trigger(row("cmd_2:0")));
    const detail = document.querySelector<HTMLElement>("[data-command-detail]")!;
    const copyCommand = within(detail.querySelector<HTMLElement>("[data-command-block]")!).getByRole("button", { name: "复制命令" });
    const copyOutput = within(detail.querySelector<HTMLElement>("[data-output-block]")!).getByRole("button", { name: "复制输出" });
    // The status footer keeps only the status.
    expect(within(detail.querySelector<HTMLElement>("[data-command-status]")!.parentElement!).queryAllByRole("button")).toHaveLength(0);
    fireEvent.click(copyCommand);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("ls -la"));
    fireEvent.click(copyOutput);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("total 0"));
  });

  it("does not expand a finished read that carries no command or output (Codex single-action read)", () => {
    renderSteps([command("cmd_1", [{ type: "read", command: null, name: "a.ts", path: "src/a.ts" }], { command: null, output: null })]);
    expect(trigger(row("cmd_1:0"))).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(trigger(row("cmd_1:0")));
    expect(screen.queryByText("无输出")).toBeNull();
    expect(row("cmd_1:0").querySelector(".lucide-chevron-right")).toBeNull();
  });

  it("strips a prompt and a shell wrapper from the displayed command", () => {
    expect(displayCommand("$ ls")).toBe("ls");
    expect(displayCommand("/bin/zsh -lc \"cat a && cat b\"")).toBe("cat a && cat b");
    expect(displayCommand("echo 'bash -lc x'")).toBe("echo 'bash -lc x'");
  });
});
