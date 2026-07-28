import { describe, expect, it } from "vitest";

import {
  projectDocDetailOptions,
  projectDocKeys,
  projectDocListOptions,
} from "./queries";

describe("projectDocKeys", () => {
  it("scopes every key on the workspace so a workspace switch swaps the cache", () => {
    expect(projectDocKeys.all("ws-1")).toEqual(["project-docs", "ws-1"]);
    expect(projectDocKeys.list("ws-1", "proj-1")).toEqual([
      "project-docs",
      "ws-1",
      "proj-1",
      "list",
      "all",
    ]);
    expect(projectDocKeys.detail("ws-1", "proj-1", "build-notes")).toEqual([
      "project-docs",
      "ws-1",
      "proj-1",
      "detail",
      "build-notes",
    ]);
  });

  it("nests project keys under the workspace prefix so WS events can invalidate by prefix", () => {
    const prefix = projectDocKeys.all("ws-1");
    for (const key of [
      projectDocKeys.project("ws-1", "proj-1"),
      projectDocKeys.list("ws-1", "proj-1"),
      projectDocKeys.list("ws-1", "proj-1", "memory"),
      projectDocKeys.detail("ws-1", "proj-1", "doc-1"),
    ]) {
      expect(key.slice(0, prefix.length)).toEqual(prefix);
    }
  });

  it("separates kind-filtered lists from the unfiltered one", () => {
    expect(projectDocKeys.list("ws-1", "proj-1", "memory")).not.toEqual(
      projectDocKeys.list("ws-1", "proj-1"),
    );
    expect(projectDocKeys.list("ws-1", "proj-1", "memory")).not.toEqual(
      projectDocKeys.list("ws-1", "proj-1", "wiki"),
    );
  });
});

describe("projectDocListOptions", () => {
  it("keys on the workspace + project and selects the docs array", () => {
    const options = projectDocListOptions("ws-1", "proj-1");

    expect(options.queryKey).toEqual(projectDocKeys.list("ws-1", "proj-1"));
    expect(options.select?.({ docs: [{ id: "pdoc_1" }] } as never)).toEqual([
      { id: "pdoc_1" },
    ]);
  });

  it("keys a kind-filtered list separately", () => {
    expect(projectDocListOptions("ws-1", "proj-1", "memory").queryKey).toEqual(
      projectDocKeys.list("ws-1", "proj-1", "memory"),
    );
  });
});

describe("projectDocDetailOptions", () => {
  it("keys on the doc ref", () => {
    expect(projectDocDetailOptions("ws-1", "proj-1", "build-notes").queryKey).toEqual(
      projectDocKeys.detail("ws-1", "proj-1", "build-notes"),
    );
  });
});
