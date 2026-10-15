import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { TraceItem } from "@multiremi/contracts/trace";
import { renderWithI18n } from "../../test/i18n";
import {
  change, command, fileChange, listFiles, message, notice, read, search, subagent, unknown, webSearch,
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

  it("nests a subagent's own steps and its report in the subagent detail", () => {
    renderSteps([
      subagent("sub_1", "Explore", { prompt: "Find the loader", output: "Loader is in config.ts" }),
      command("cmd_c", [read("config.ts")], { parent_id: "sub_1" }),
    ]);
    const breaker = document.querySelector<HTMLElement>('[data-step-breaker="sub_1"]')!;
    expect(trigger(breaker)).toHaveTextContent("子代理已完成：Explore");
    expect(screen.queryByText("已读取 config.ts")).toBeNull();
    fireEvent.click(trigger(breaker));
    expect(screen.getByText("Find the loader")).toBeInTheDocument();
    expect(screen.getByText("已读取 config.ts")).toBeInTheDocument();
    expect(screen.getByText("Loader is in config.ts")).toBeInTheDocument();
  });

  it("shows a background subagent as running in the background (spec §13)", () => {
    renderSteps([subagent("sub_bg", "Count files", { status: "in_progress", completed_at: null, background: true })]);
    expect(document.querySelector('[data-step-breaker="sub_bg"]')).toHaveTextContent("后台运行中：Count files");
  });

  it("marks an error notice", () => {
    renderSteps([notice("ntc:1", "Rate limited", "error")]);
    expect(trigger(document.querySelector('[data-step-breaker="ntc:1"]')!).className).toContain("text-destructive");
  });
});

describe("command detail", () => {
  it("clamps the command to two lines until clicked and keeps its output at most 144px", () => {
    const script = "bun run test \\\n  --filter views \\\n  --reporter dot";
    renderSteps([command("cmd_1", [unknown(script)], { output: "line 1\nline 2\n✓ done" })]);
    fireEvent.click(trigger(row("cmd_1:0")));
    const detail = document.querySelector<HTMLElement>("[data-command-detail]")!;
    const commandButton = detail.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(commandButton.textContent).toBe(script);
    const commandText = commandButton.querySelector<HTMLElement>("[data-command-text]")!;
    const classes = () => commandText.className.split(/\s+/);
    // `block` would override the clamp's display, so the two never coexist.
    expect(classes()).toContain("line-clamp-2");
    expect(classes()).not.toContain("block");
    fireEvent.click(commandButton);
    expect(classes()).toContain("block");
    expect(classes()).not.toContain("line-clamp-2");
    const output = detail.querySelector<HTMLElement>("[data-command-output]")!;
    expect(output.className).toContain("max-h-36");
    expect(output.className).toContain("text-[13px]");
    expect(detail.querySelector("[data-command-status]")).toHaveTextContent("成功");
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

  it("says 无输出 and copies the command and the output separately", async () => {
    const { unmount } = renderSteps([command("cmd_1", [unknown("true")], { output: null })]);
    fireEvent.click(trigger(row("cmd_1:0")));
    expect(screen.getByText("无输出")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制输出" })).toBeNull();
    unmount();
    renderSteps([command("cmd_2", [unknown("bash -lc 'ls -la'")], { command: "bash -lc 'ls -la'", output: "total 0" })]);
    fireEvent.click(trigger(row("cmd_2:0")));
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith("ls -la"));
    fireEvent.click(screen.getByRole("button", { name: "复制输出" }));
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
