import { describe, expect, it } from "bun:test";
import type {
  FileChange,
  TraceAgentMessageItem,
  TraceCommandItem,
  TraceItem,
  TraceReasoningItem,
  TraceToolItem,
} from "@multiremi/contracts/trace";
import { isFileChange, isTraceItem } from "@multiremi/contracts/trace";
import { fileChangeFromTexts } from "@shared/trace-file-change.js";
import {
  TRACE_EVENT_MAX_BYTES,
  TRACE_ITEM_COMMAND_MAX_BYTES,
  TRACE_ITEM_CWD_MAX_BYTES,
  TRACE_ITEM_DIFF_MAX_BYTES,
  TRACE_ITEM_INPUT_MAX_BYTES,
  TRACE_ITEM_OUTPUT_HEAD_BYTES,
  TRACE_ITEM_OUTPUT_TAIL_BYTES,
  TRACE_ITEM_REASONING_MAX_BYTES,
  TRACE_ITEM_TEXT_MAX_BYTES,
  TRACE_TRUNCATION_MARKER,
  capCommandActions,
  capFileChanges,
  capItemInput,
  capItemText,
  capOutput,
  capTraceEvent,
  capTraceItem,
  utf8ByteLength,
} from "@shared/trace-sanitize.js";

const NOW = "2026-10-15T00:00:00.000Z";
const KiB = 1024;
const bytes = (value: string) => new TextEncoder().encode(value).length;

function command(output: string | null): TraceCommandItem {
  return {
    id: "call_1", parent_id: null, status: "completed", started_at: NOW, completed_at: NOW, type: "command", tool: "Bash",
    source: "shell", command: "make", cwd: null, actions: [{ type: "unknown", command: "make" }], output, exit_code: 0, duration_ms: 1,
  };
}

describe("item caps", () => {
  it("measures UTF-8 without allocating", () => {
    for (const value of ["", "abc", "é", "中文", "😀", "a😀b", "\uD800"]) expect(utf8ByteLength(value)).toBe(bytes(value));
  });

  it("cuts text on a character boundary and flags it", () => {
    expect(capItemText("short")).toEqual({ value: "short", truncated: false });
    const long = "中".repeat(100);
    const capped = capItemText(long, 10);
    expect(capped).toEqual({ value: `中中中${TRACE_TRUNCATION_MARKER}`, truncated: true });
    expect(capItemText(capped.value, 10).value).toBe(capped.value);
  });

  it("keeps the first 16 KiB and the last 48 KiB of an output around the marker", () => {
    expect(capOutput(null)).toEqual({ value: null, truncated: false });
    const fits = "x".repeat(64 * KiB);
    expect(capOutput(fits)).toEqual({ value: fits, truncated: false });
    const output = `${"h".repeat(20 * KiB)}${"m".repeat(40 * KiB)}${"t".repeat(50 * KiB)}`;
    const capped = capOutput(output);
    expect(capped.truncated).toBe(true);
    const [head, tail] = capped.value!.split(`\n${TRACE_TRUNCATION_MARKER}\n`);
    expect(head).toBe("h".repeat(TRACE_ITEM_OUTPUT_HEAD_BYTES));
    expect(tail).toBe("t".repeat(TRACE_ITEM_OUTPUT_TAIL_BYTES));
    // Re-capping a capped output is a no-op.
    expect(capOutput(capped.value).value).toBe(capped.value);
  });

  it("never splits a multi-byte character at either end", () => {
    const capped = capOutput("é".repeat(40 * KiB), 3, 3).value!;
    expect(capped).toBe(`é\n${TRACE_TRUNCATION_MARKER}\né`);
  });

  it("shrinks long input strings before giving up on the input", () => {
    expect(capItemInput(null)).toEqual({ value: null, truncated: false });
    expect(capItemInput({ path: "a.ts" })).toEqual({ value: { path: "a.ts" }, truncated: false });
    const write = capItemInput({ file_path: "/repo/a.ts", content: "x".repeat(100 * KiB) });
    expect(write.truncated).toBe(true);
    expect(write.value?.file_path).toBe("/repo/a.ts");
    expect(bytes(JSON.stringify(write.value))).toBeLessThanOrEqual(TRACE_ITEM_INPUT_MAX_BYTES);
    const wide = capItemInput(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`key_${i}`, i])));
    expect(wide).toEqual({ value: null, truncated: true });
  });

  it("caps diffs per change and per item, keeping the counts", () => {
    const big: FileChange = { path: "a.ts", kind: "update", move_path: null, diff: `+${"x".repeat(100 * KiB)}`, added: 1, removed: 0 };
    const capped = capFileChanges([big, big, big, big, big]);
    expect(capped.truncated).toBe(true);
    const sizes = capped.value.map((change) => change.diff === null ? null : bytes(change.diff));
    expect(sizes.slice(0, 4).every((size) => size !== null && size <= TRACE_ITEM_DIFF_MAX_BYTES + bytes(TRACE_TRUNCATION_MARKER))).toBe(true);
    expect(sizes[4]).toBeNull();
    expect(capped.value.every((change) => change.diff_truncated === true && change.added === 1)).toBe(true);
    // Re-checking a capped item (the store re-checks what the translator capped) changes nothing.
    expect(capFileChanges(capped.value).value).toEqual(capped.value);
    const small: FileChange = { ...big, diff: "+x" };
    expect(capFileChanges([small])).toEqual({ value: [small], truncated: false });
  });

  it("applies the caps for each item type and leaves small items untouched", () => {
    const small = command("ok");
    expect(capTraceItem(small)).toBe(small);

    const loud = capTraceItem(command("y".repeat(200 * KiB)));
    expect(loud.output_truncated).toBe(true);
    expect(bytes(loud.output!)).toBeLessThan(65 * KiB);

    const reply = capTraceItem<TraceAgentMessageItem>({ id: "m", parent_id: null, status: "completed", started_at: NOW,
      completed_at: NOW, type: "agent_message", text: "z".repeat(TRACE_ITEM_TEXT_MAX_BYTES + 1), phase: "final" });
    expect(reply.truncated).toBe(true);
    const thought = capTraceItem<TraceReasoningItem>({ id: "r", parent_id: null, status: "completed", started_at: NOW,
      completed_at: NOW, type: "reasoning", text: "z".repeat(TRACE_ITEM_REASONING_MAX_BYTES + 1) });
    expect(thought.truncated).toBe(true);
    expect(bytes(thought.text)).toBe(TRACE_ITEM_REASONING_MAX_BYTES + bytes(TRACE_TRUNCATION_MARKER));

    const tool = capTraceItem({ id: "t", parent_id: null, status: "completed", started_at: NOW, completed_at: NOW, type: "tool",
      tool: "t".repeat(600), server: null, kind: null, title: "T".repeat(600), input: { blob: "b".repeat(50 * KiB) },
      output: null, duration_ms: null } satisfies TraceToolItem);
    expect(bytes(tool.tool)).toBeLessThanOrEqual(512 + bytes(TRACE_TRUNCATION_MARKER));
    expect(bytes(tool.title!)).toBeLessThanOrEqual(512 + bytes(TRACE_TRUNCATION_MARKER));
    expect(bytes(JSON.stringify(tool.input))).toBeLessThanOrEqual(TRACE_ITEM_INPUT_MAX_BYTES);
    // Decision Q3: every capped field says so.
    expect((tool as TraceToolItem).input_truncated).toBe(true);
    const base = { parent_id: null, status: "completed" as const, started_at: NOW, completed_at: NOW, duration_ms: null };
    const longOutput = "o".repeat(200 * KiB);
    const edit = capTraceItem({ ...base, id: "f", type: "file_change", tool: "Edit", changes: [], output: longOutput } as TraceItem);
    const web = capTraceItem({ ...base, id: "w", type: "web_search", tool: "WebFetch", action: "fetch", query: null, url: null, output: longOutput } as TraceItem);
    const agent = capTraceItem({ ...base, id: "a", type: "subagent", tool: "Task", title: null, prompt: null, output: longOutput } as TraceItem);
    for (const item of [edit, web, agent]) expect((item as { output_truncated?: true }).output_truncated).toBe(true);
    for (const item of [loud, reply, thought, tool, edit, web, agent]) {
      expect(isTraceItem(item)).toBe(true);
      expect(capTraceItem(item)).toEqual(item);
    }
  });

  it("caps the optional §13 labels when present and leaves absent ones absent", () => {
    const long = "L".repeat(600);
    const base = { parent_id: null, status: "completed" as const, started_at: NOW, completed_at: NOW, duration_ms: null };
    const agent = capTraceItem({ ...base, id: "a", type: "subagent", tool: "Agent", title: null, prompt: null, output: null,
      agent_type: long, name: long, background: true, model: long, thread_id: long } as TraceItem) as unknown as Record<string, unknown>;
    for (const key of ["agent_type", "name", "model", "thread_id"]) {
      expect(bytes(agent[key] as string), key).toBeLessThanOrEqual(512 + bytes(TRACE_TRUNCATION_MARKER));
    }
    expect(agent.background).toBe(true);
    const titled = capTraceItem({ ...command("ok"), title: long } as TraceItem) as unknown as Record<string, unknown>;
    expect(bytes(titled.title as string)).toBeLessThanOrEqual(512 + bytes(TRACE_TRUNCATION_MARKER));
    const plain = command("ok");
    expect(capTraceItem(plain)).toBe(plain);
    expect("title" in capTraceItem(plain)).toBe(false);
    for (const item of [agent, titled]) expect(isTraceItem(item)).toBe(true);
  });

  it("drops the largest fields of an event over 1 MiB", () => {
    const body = {
      type: "item.completed",
      item: {
        id: "s", parent_id: null, status: "completed", started_at: NOW, completed_at: NOW, type: "subagent", tool: "Task",
        title: null, prompt: "p".repeat(TRACE_EVENT_MAX_BYTES), output: null, duration_ms: null,
      },
    } as const;
    const capped = capTraceEvent(body);
    expect(capped).not.toBeNull();
    expect(capped!.item).toMatchObject({ prompt: null });
    expect(bytes(JSON.stringify(capped))).toBeLessThanOrEqual(TRACE_EVENT_MAX_BYTES);

    // An item that fits alone but not inside its envelope is still reduced: the ceiling bounds the whole body.
    const empty = { ...body.item, prompt: "" };
    const fitsAlone = { type: "item.completed", item: { ...empty, prompt: "p".repeat(TRACE_EVENT_MAX_BYTES - bytes(JSON.stringify(empty))) } } as const;
    expect(bytes(JSON.stringify(fitsAlone.item))).toBe(TRACE_EVENT_MAX_BYTES);
    const bounded = capTraceEvent(fitsAlone);
    expect(bounded!.item).toMatchObject({ prompt: null });
    expect(bytes(JSON.stringify(bounded))).toBeLessThanOrEqual(TRACE_EVENT_MAX_BYTES);

    // A command's parsed actions are a drop candidate: the line and the result survive.
    const paths = Array.from({ length: 600 }, (_, i) => ({ type: "read" as const, command: null, name: `f${i}`, path: `/r/${"d".repeat(2 * KiB)}/${i}` }));
    const listing = capTraceEvent({ type: "item.completed", item: { ...command("tail"), command: "cat many", actions: paths } });
    expect(listing).not.toBeNull();
    expect(listing!.item).toMatchObject({ command: "cat many", actions: [], command_truncated: true, output: "tail" });
    expect(bytes(JSON.stringify(listing))).toBeLessThanOrEqual(TRACE_EVENT_MAX_BYTES);
    expect(isTraceItem(listing!.item)).toBe(true);

    const delta = capTraceEvent({ type: "item.delta", item_id: "call_1", field: "output", delta: "d".repeat(100 * KiB) });
    expect(delta && delta.type === "item.delta" && bytes(delta.delta)).toBe(64 * KiB);
    const fine = { type: "turn.updated", patch: { model: "m" } } as const;
    expect(capTraceEvent(fine)).toBe(fine);
  });
});

describe("command caps", () => {
  const heredoc = `cat <<'EOF' > big.txt\n${"x".repeat(600 * KiB)}\nEOF`;

  it("caps the command line, the cwd and the actions' commands, and flags the item", () => {
    const item = capTraceItem<TraceCommandItem>({
      ...command(null), command: heredoc, cwd: `/${"c".repeat(8 * KiB)}`,
      actions: [{ type: "unknown", command: heredoc }, { type: "search", command: heredoc, query: "x", path: null }],
    });
    expect(item.command_truncated).toBe(true);
    expect(item.command!.startsWith("cat <<'EOF' > big.txt\nxxx")).toBe(true);
    expect(item.command!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(bytes(item.command!)).toBe(TRACE_ITEM_COMMAND_MAX_BYTES + bytes(TRACE_TRUNCATION_MARKER));
    expect(bytes(item.cwd!)).toBe(TRACE_ITEM_CWD_MAX_BYTES + bytes(TRACE_TRUNCATION_MARKER));
    // The actions share one budget: the first keeps the head, the second only the marker.
    expect(bytes(item.actions[0]!.command!)).toBe(TRACE_ITEM_COMMAND_MAX_BYTES + bytes(TRACE_TRUNCATION_MARKER));
    expect(item.actions[1]).toEqual({ type: "search", command: TRACE_TRUNCATION_MARKER, query: "x", path: null });
    expect(isTraceItem(item)).toBe(true);
    // The store re-checks what the translator capped: a no-op.
    expect(capTraceItem(item)).toEqual(item);
    expect(capCommandActions(item.actions).value).toEqual(item.actions);
    // A short command is untouched and gains no flag.
    const small = command("ok");
    expect(capTraceItem(small)).toBe(small);
    expect(capCommandActions([{ type: "list_files", command: null, path: null }]).truncated).toBe(false);
  });

  it("keeps a 600 KiB heredoc event under the ceiling instead of dropping it", () => {
    const item: TraceCommandItem = { ...command("done"), command: heredoc, actions: [{ type: "unknown", command: heredoc }] };
    const body = { type: "item.completed" as const, item };
    expect(bytes(JSON.stringify(body))).toBeGreaterThan(TRACE_EVENT_MAX_BYTES);
    const capped = capTraceEvent(body);
    expect(capped).not.toBeNull();
    expect(capped!.item).toMatchObject({ type: "command", command_truncated: true, output: "done", exit_code: 0 });
    expect(bytes(JSON.stringify(capped))).toBeLessThan(40 * KiB);
  });

  it("rejects a malformed command_truncated", () => {
    expect(isTraceItem({ ...command(null), command_truncated: true })).toBe(true);
    expect(isTraceItem({ ...command(null), command_truncated: false })).toBe(false);
  });
});

describe("fileChangeFromTexts", () => {
  it("diffs an update into unified body lines without line numbers", () => {
    const change = fileChangeFromTexts("src/a.ts", "one\ntwo\nthree\n", "one\n2\nthree\nfour\n");
    expect(change).toEqual({
      path: "src/a.ts", kind: "update", move_path: null,
      diff: ["@@", " one", "-two", "+2", " three", "+four"].join("\n"),
      added: 2, removed: 1,
    });
    expect(isFileChange(change)).toBe(true);
  });

  it("infers add and delete, and honours an explicit kind and move", () => {
    expect(fileChangeFromTexts("new.ts", null, "a\nb")).toMatchObject({ kind: "add", diff: "@@\n+a\n+b", added: 2, removed: 0 });
    expect(fileChangeFromTexts("old.ts", "a\n", null)).toMatchObject({ kind: "delete", diff: "@@\n-a", added: 0, removed: 1 });
    expect(fileChangeFromTexts("a.ts", "x", "y", { kind: "update", movePath: "b.ts" })).toMatchObject({ kind: "update", move_path: "b.ts" });
  });

  it("separates distant hunks and drops no-newline markers", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 2", "LINE 2").replace("line 27", "LINE 27");
    const change = fileChangeFromTexts("a.ts", before, after);
    expect(change.diff!.split("\n").filter((line) => line === "@@")).toHaveLength(2);
    expect(change.diff).not.toContain("\\ No newline");
    expect(change).toMatchObject({ added: 2, removed: 2 });
  });

  it("reports no diff for identical texts", () => {
    expect(fileChangeFromTexts("a.ts", "same", "same")).toEqual({ path: "a.ts", kind: "update", move_path: null, diff: null, added: 0, removed: 0 });
  });

  it("caps a large diff and keeps the full counts", () => {
    const after = Array.from({ length: 20_000 }, (_, i) => `added line ${i}`).join("\n");
    const change = fileChangeFromTexts("big.ts", "", after);
    expect(change.added).toBe(20_000);
    expect(change.diff_truncated).toBe(true);
    expect(bytes(change.diff!)).toBeLessThanOrEqual(TRACE_ITEM_DIFF_MAX_BYTES + bytes(TRACE_TRUNCATION_MARKER));
  });
});

describe("fileChangeFromTexts bounds", () => {
  it("reports an oversized update without a body", () => {
    const before = "a\n".repeat(400_000);
    const after = "b\n".repeat(400_000);
    const started = performance.now();
    const change = fileChangeFromTexts("huge.txt", before, after);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(change).toEqual({ path: "huge.txt", kind: "update", move_path: null, diff: null, added: 400_000, removed: 400_000, diff_truncated: true });
  });

  it("gives up on a slow diff instead of blocking", () => {
    const lines = (seed: number) => Array.from({ length: 20_000 }, (_, i) => `${(i * seed) % 7919}`).join("\n");
    const started = performance.now();
    const change = fileChangeFromTexts("slow.txt", lines(31), lines(37));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(change.added).toBeGreaterThan(0);
  });
});
