// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { activityPreferencesStore, useActivityPreferences } from "./activity-preferences-store";

vi.mock("../../hooks", () => ({ useWorkspaceId: () => "hydration-workspace" }));

describe("activity preference hydration", () => {
  it.each([false, true])("waits for the saved display set before declaring ready (%s)", async saved => {
    const user = `hydration-user-${saved}`;
    activityPreferencesStore(user, "hydration-workspace").getState().setShowSystemDetails(saved);
    const commits: Array<{ ready: boolean; shown: boolean }> = [];
    function Consumer() {
      const { ready, showSystemDetails } = useActivityPreferences(user);
      useLayoutEffect(() => { commits.push({ ready, shown: showSystemDetails }); }, [ready, showSystemDetails]);
      return createElement("div", { "data-ready": String(ready) }, showSystemDetails ? "system detail" : "comments");
    }
    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement(Consumer));
    document.body.append(container);
    expect(container.firstElementChild?.getAttribute("data-ready")).toBe("false");
    expect(container.textContent).toBe("comments");
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, createElement(Consumer)); });
      expect(container.firstElementChild?.getAttribute("data-ready")).toBe("true");
      expect(container.textContent).toBe(saved ? "system detail" : "comments");
      expect(commits.filter(commit => commit.ready)).toEqual([{ ready: true, shown: saved }]);
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });
});
