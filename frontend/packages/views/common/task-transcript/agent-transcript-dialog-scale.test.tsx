import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TraceItem } from "@multiremi/contracts/trace";
import type { AgentTask } from "@multiremi/core/types/agent";
import { renderWithI18n } from "../../test/i18n";
import { command, read, subagent, traceTurn, unknown } from "../../test/trace-fixtures";
import { AgentTranscriptDialog } from "./agent-transcript-dialog";

// Large traces: the dialog redacts each item once, indexes children in one
// pass and re-renders only the rows whose item changed. The spies wrap the
// real functions and count work per item, a structural stand-in for timing.

const { redactSpy, summarySpy } = vi.hoisted(() => ({ redactSpy: vi.fn(), summarySpy: vi.fn() }));
vi.mock("./redact", async (original) => {
  const actual = await original<typeof import("./redact")>();
  // Count real redactions: a cached result comes back as the same object.
  const seen = new WeakSet<object>();
  return { ...actual, redactItem: (item: object) => {
    const out = actual.redactItem(item);
    if (!seen.has(out)) { seen.add(out); redactSpy(item); }
    return out;
  } };
});
vi.mock("./event-format", async (original) => {
  const actual = await original<typeof import("./event-format")>();
  return { ...actual, getItemSummary: (item: TraceItem) => { summarySpy(item); return actual.getItemSummary(item); } };
});
vi.mock("@multiremi/core/api", () => ({ api: { getTurnInput: vi.fn(), getAgent: vi.fn(), listRuntimes: vi.fn() } }));
vi.mock("../markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));

const task = {
  id: "task-1", agent_id: "", runtime_id: "", issue_id: "", status: "running", priority: 0, dispatched_at: null,
  started_at: null, completed_at: null, result: null, error: null, created_at: "2026-07-30T00:00:00Z",
} as AgentTask;

function dialog(items: readonly TraceItem[]) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <AgentTranscriptDialog open onOpenChange={() => {}} task={task} turn={traceTurn()} items={items} agentName="Remi" isLive />
    </QueryClientProvider>
  );
}

describe("transcript dialog on a large trace", () => {
  it("renders 2000 items with one redaction and one row render each, then re-renders only what changed", () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    // A subagent owning 1000 steps, then 999 top-level commands.
    const items: TraceItem[] = [subagent("sub_1", "Explore")];
    for (let i = 0; i < 1000; i++) items.push(command(`child_${i}`, [read(`c${i}.ts`)], { parent_id: "sub_1" }));
    for (let i = 0; i < 999; i++) items.push(command(`cmd_${i}`, [unknown(`echo ${i}`)]));
    const view = renderWithI18n(dialog(items));
    expect(redactSpy).toHaveBeenCalledTimes(2000);
    expect(document.querySelectorAll("[data-transcript-item]")).toHaveLength(1000);
    // Rows render once each (children stay unrendered inside the collapsed subagent).
    const firstRender = summarySpy.mock.calls.length;
    expect(firstRender).toBeLessThanOrEqual(1000 * 2);

    // A live frame appends one item and replaces another: the 1998 untouched
    // items are neither redacted again nor re-rendered.
    redactSpy.mockClear();
    summarySpy.mockClear();
    const next = [...items];
    next[1500] = { ...items[1500]!, output: "changed" } as TraceItem;
    next.push(command("cmd_new", [unknown("echo new")]));
    view.rerender(dialog(next));
    expect(redactSpy).toHaveBeenCalledTimes(2);
    expect(summarySpy.mock.calls.length).toBeLessThanOrEqual(2 * 2);
    expect(document.querySelectorAll("[data-transcript-item]")).toHaveLength(1001);
    // The assertions count work, not time; mounting 1000 rows in jsdom takes
    // several seconds on CI runners.
  }, 30000);
});
