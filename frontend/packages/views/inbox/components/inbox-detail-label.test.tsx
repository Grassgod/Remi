import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { InboxItem } from "@multiremi/core/types";
import { describe, expect, it, vi } from "vitest";
import enInbox from "../../locales/en/inbox.json";
import zhInbox from "../../locales/zh-Hans/inbox.json";
import { InboxDetailLabel } from "./inbox-detail-label";

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (_type: string, id: string) => id }),
}));

vi.mock("../../issues/components", () => ({
  StatusIcon: () => null,
  PriorityIcon: () => null,
}));

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "workspace-1",
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: "system",
    actor_id: null,
    type: "autopilot_run_completed",
    severity: "info",
    issue_id: null,
    title: "Server fallback",
    body: "Completed in 12s | No changes.",
    issue_status: null,
    read: false,
    archived: false,
    created_at: "2026-08-27T09:00:00Z",
    details: null,
    ...overrides,
  };
}

function renderLabel(value: InboxItem, locale: "en" | "zh-Hans" = "en") {
  return render(
    <I18nProvider
      locale={locale}
      resources={{
        en: { inbox: enInbox },
        "zh-Hans": { inbox: zhInbox },
      }}
    >
      <InboxDetailLabel item={value} />
    </I18nProvider>,
  );
}

describe("InboxDetailLabel autopilot outcomes", () => {
  it("renders a localized no-change result instead of the English fallback", () => {
    renderLabel(item({
      details: {
        duration_seconds: 12,
        outcome: { kind: "no_change", text: null, links: [], counts: null },
      },
    }), "zh-Hans");

    expect(screen.getByText("本次无变更")).toBeInTheDocument();
    expect(screen.getByText(/耗时 12 秒/)).toBeInTheDocument();
    expect(screen.queryByText(/Completed in/)).not.toBeInTheDocument();
  });

  it("renders change counts and clickable PR/MR links", () => {
    renderLabel(item({
      details: {
        duration_seconds: 9,
        outcome: {
          kind: "changes",
          text: "Updated the docs.",
          links: [
            { kind: "pull_request", url: "https://github.com/Grassgod/Remi/pull/80", number: 80 },
            { kind: "merge_request", url: "https://code.byted.org/acme/docs/merge_requests/12", number: 12 },
          ],
          counts: { changes: 2 },
        },
      },
    }));

    expect(screen.getByText("2 changes")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR #80" })).toHaveAttribute(
      "href",
      "https://github.com/Grassgod/Remi/pull/80",
    );
    expect(screen.getByRole("link", { name: "MR #12" })).toHaveAttribute(
      "href",
      "https://code.byted.org/acme/docs/merge_requests/12",
    );
  });

  it("localizes the failure wrapper while preserving the cleaned agent summary", () => {
    renderLabel(item({
      type: "autopilot_run_failed",
      details: {
        outcome: {
          kind: "failed",
          text: "Dependency service unavailable.",
          links: [],
          counts: null,
        },
      },
    }), "zh-Hans");

    expect(screen.getByText("失败：Dependency service unavailable.")).toBeInTheDocument();
  });
});
