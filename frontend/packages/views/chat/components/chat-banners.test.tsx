import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { CHAT_COLUMN_CLASS } from "../lib/chat-column";
import { NoAgentBanner } from "./no-agent-banner";
import { OfflineBanner } from "./offline-banner";

/** The banner's visible box fills the Chat column, edge to edge with the composer below it. */
function expectInChatColumn(text: RegExp) {
  const box = screen.getByText(text).parentElement!;
  expect(box.parentElement).toHaveClass(...CHAT_COLUMN_CLASS.split(" "));
  expect(box.className).not.toMatch(/(^|\s)(max-w-|mx-)/);
}

describe("Chat banners above the composer", () => {
  it("puts the offline and unstable notices in the shared Chat column", () => {
    const view = renderWithI18n(<OfflineBanner agentName="Remi" availability="offline" />);
    expectInChatColumn(/No online machine can run Remi/);
    view.rerender(<OfflineBanner agentName="Remi" availability="unstable" />);
    expectInChatColumn(/machines that run Remi are unstable/);
  });

  it("puts the no-agent notice in the shared Chat column", () => {
    renderWithI18n(<NoAgentBanner />);
    expectInChatColumn(/You need an agent/);
  });
});
