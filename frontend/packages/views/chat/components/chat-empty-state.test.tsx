// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid={`avatar-${actorId}`} />
  ),
}));

import { EmptyState } from "./chat-empty-state";

const TEST_RESOURCES = { en: { chat: enChat, issues: enIssues } };

function renderEmptyState({
  hasSessions = true,
  noAgent = false,
}: {
  hasSessions?: boolean;
  noAgent?: boolean;
} = {}) {
  const onPickPrompt = vi.fn();
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <EmptyState
        hasSessions={hasSessions}
        agentName="Alpha"
        noAgent={noAgent}
        onPickPrompt={onPickPrompt}
      />
    </I18nProvider>,
  );
  return { onPickPrompt };
}

describe("ChatWindow EmptyState", () => {
  it("offers live starter prompts to a returning user with an agent", () => {
    const { onPickPrompt } = renderEmptyState();

    expect(screen.getByText("Try asking")).toBeInTheDocument();
    const prompt = screen.getByRole("button", {
      name: /List my open tasks by priority/,
    });
    expect(prompt).toBeEnabled();

    fireEvent.click(prompt);
    expect(onPickPrompt).toHaveBeenCalledWith(
      "List my open tasks by priority",
    );
  });

  it("disables the starter prompts and explains why when the workspace has no agent", () => {
    const { onPickPrompt } = renderEmptyState({ noAgent: true });

    expect(
      screen.getByText(
        "Add an agent to this workspace first — these prompts need one to run.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Try asking")).not.toBeInTheDocument();

    // handleSend early-returns without an agent, so a live button here would
    // be a click that produces nothing — no message, no toast, no feedback.
    for (const prompt of screen.getAllByRole("button")) {
      expect(prompt).toBeDisabled();
      fireEvent.click(prompt);
    }
    expect(onPickPrompt).not.toHaveBeenCalled();
  });

  it("educates instead of prompting on a first-ever visit", () => {
    renderEmptyState({ hasSessions: false });

    expect(screen.getByText("Chat with your agents")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
