import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MessageHeader } from "./message-header";
import { renderWithI18n } from "../test/i18n";
import { messageFixture } from "../test/messages";
describe("message header", () => {
  it("shows the role, message kind and applied wake with an understandable reason", () => {
    const { container } = renderWithI18n(<MessageHeader message={messageFixture({ to_type: "role", to_ref: "parent_owner", message_kind: "request", wake_requested: "now", wake_applied: "next_turn", wake_reason: "pair_round_trip_limit" })} />);
    expect(screen.getByText("To Parent owner")).toBeInTheDocument(); expect(screen.getByText("Request")).toBeInTheDocument();
    expect(container.querySelector('[data-wake-applied="next_turn"]')).toHaveAttribute("title", "Agent exchange limit reached");
    expect(screen.queryByText("Wake now")).toBeNull();
  });
  it("preserves future enums without losing the recipient", () => {
    renderWithI18n(<MessageHeader message={messageFixture({ message_kind: "future_kind", wake_applied: "future_wake" })} getActorName={() => "Jane"} />);
    expect(screen.getByText("To Jane")).toBeInTheDocument(); expect(screen.getByText("future_kind")).toBeInTheDocument(); expect(screen.getByText("future_wake")).toBeInTheDocument();
  });
});
