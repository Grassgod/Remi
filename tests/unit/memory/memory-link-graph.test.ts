import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "@memory/store.js";
import { parseWikilinks, extractSnippet, LinkGraph } from "@memory/link-graph.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `remi-test-lg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("parseWikilinks", () => {
  it("parses simple [[target]]", () => {
    const links = parseWikilinks("Jack works on [[Remi]] daily.");
    expect(links).toHaveLength(1);
    expect(links[0]!.rawTarget).toBe("Remi");
    expect(links[0]!.displayText).toBe("Remi");
  });

  it("parses [[target|alias]]", () => {
    const links = parseWikilinks("See [[Alice-Chen|Alice]] for details.");
    expect(links).toHaveLength(1);
    expect(links[0]!.rawTarget).toBe("Alice-Chen");
    expect(links[0]!.displayText).toBe("Alice");
  });

  it("parses multiple links in one text", () => {
    const links = parseWikilinks("[[A]] [[B]] some text [[C|see C]]");
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.rawTarget)).toEqual(["A", "B", "C"]);
  });

  it("ignores single brackets", () => {
    const links = parseWikilinks("This [is] not a [link] [[RealLink]]");
    expect(links).toHaveLength(1);
    expect(links[0]!.rawTarget).toBe("RealLink");
  });

  it("handles CJK characters in target", () => {
    const links = parseWikilinks("关于 [[贺华杰]] 的信息");
    expect(links).toHaveLength(1);
    expect(links[0]!.rawTarget).toBe("贺华杰");
  });

  it("trims whitespace in target", () => {
    const links = parseWikilinks("[[  Remi  ]] and [[ A | display ]]");
    expect(links).toHaveLength(2);
    expect(links[0]!.rawTarget).toBe("Remi");
    expect(links[1]!.rawTarget).toBe("A");
    expect(links[1]!.displayText).toBe("display");
  });
});

describe("extractSnippet", () => {
  it("extracts context around an index", () => {
    const text = "Alice met Jack at the [[Remi]] launch event in Shanghai.";
    const idx = text.indexOf("[[Remi]]");
    const snip = extractSnippet(text, idx, 15);
    expect(snip).toContain("[[Remi]]");
  });

  it("adds ellipsis for truncated edges", () => {
    const text = "abc ".repeat(50) + " [[X]] " + "def ".repeat(50);
    const idx = text.indexOf("[[X]]");
    const snip = extractSnippet(text, idx, 20);
    expect(snip).toMatch(/^…/);
    expect(snip).toMatch(/…$/);
  });
});

describe("LinkGraph", () => {
  it("builds bidirectional index from linked files", () => {
    const graph = new LinkGraph({
      resolve: (t: string) => t, // identity resolver for test
    });
    graph.rebuild([
      { entityName: "Alice", path: "a.md", content: "Works on [[Remi]] and [[larkparser]]" },
      { entityName: "Bob", path: "b.md", content: "Also works on [[Remi]]" },
      { entityName: "Remi", path: "r.md", content: "Self content" },
    ]);

    expect(graph.getForwardLinks("Alice").sort()).toEqual(["Remi", "larkparser"]);
    expect(graph.getForwardLinks("Bob")).toEqual(["Remi"]);

    const remiBacks = graph.getBacklinks("Remi");
    expect(remiBacks).toHaveLength(2);
    expect(remiBacks.map((b) => b.source).sort()).toEqual(["Alice", "Bob"]);
  });

  it("ignores unresolvable links", () => {
    const graph = new LinkGraph({
      resolve: (t: string) => (t === "Known" ? "Known" : null),
    });
    graph.rebuild([
      { entityName: "Src", path: "s.md", content: "[[Known]] and [[Unknown]]" },
    ]);
    expect(graph.getForwardLinks("Src")).toEqual(["Known"]);
  });

  it("ignores self-links", () => {
    const graph = new LinkGraph({ resolve: (t: string) => t });
    graph.rebuild([
      { entityName: "A", path: "a.md", content: "See also [[A]]" },
    ]);
    expect(graph.getForwardLinks("A")).toEqual([]);
    expect(graph.getBacklinks("A")).toEqual([]);
  });

  it("provides snippet context in backlinks", () => {
    const graph = new LinkGraph({ resolve: (t: string) => t });
    graph.rebuild([
      { entityName: "Src", path: "s.md", content: "Background text. [[Target]] was mentioned here. More text." },
    ]);
    const backs = graph.getBacklinks("Target");
    expect(backs).toHaveLength(1);
    expect(backs[0]!.snippet).toContain("[[Target]]");
  });
});

describe("MemoryStore integration with LinkGraph", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new MemoryStore(join(tmpDir, "memory"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves alias via entity index", () => {
    // Write an entity with alias in frontmatter by direct file write
    const fs = require("node:fs");
    const peopleDir = join(store.root, "entities", "people");
    fs.mkdirSync(peopleDir, { recursive: true });
    const aliceFile = join(peopleDir, "Alice-Chen.md");
    fs.writeFileSync(
      aliceFile,
      `---
type: person
name: Alice-Chen
aliases: [Alice, 小陈]
---

# Alice-Chen
CV engineer.
`,
    );
    const bobFile = join(peopleDir, "Bob.md");
    fs.writeFileSync(
      bobFile,
      `---
type: person
name: Bob
---

# Bob
Bob works with [[Alice]] on CV project.
`,
    );

    // Refresh store index to pick up new files
    store._buildIndex();
    (store as unknown as { _rebuildLinkGraph(): void })._rebuildLinkGraph();

    const backs = store.getBacklinks("Alice-Chen");
    expect(backs.length).toBeGreaterThanOrEqual(1);
    expect(backs.find((b) => b.source === "Bob")).toBeDefined();
  });

  it("updates graph after remember() call", () => {
    store.remember("Remi", "project", "AI orchestrator", "personal", null);
    store.remember("Jack-Ho", "person", "Creator of [[Remi]]", "personal", null);

    const backs = store.getBacklinks("Remi");
    expect(backs.length).toBeGreaterThanOrEqual(1);
    expect(backs.find((b) => b.source === "Jack-Ho")).toBeDefined();

    const forward = store.getForwardLinks("Jack-Ho");
    expect(forward).toContain("Remi");
  });
});
