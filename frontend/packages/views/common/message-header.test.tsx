import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { WorkspaceSlugProvider } from "@multiremi/core/paths";
import { MessageHeader } from "./message-header";
import { NavigationProvider } from "../navigation";
import { renderWithI18n } from "../test/i18n";
import { messageFixture } from "../test/messages";

const source = { actor_type: "member", actor_id: "mem_h", actor_name: "测试用户", message_id: "cmt_original",
  session_id: "ises_original", issue_id: "iss_original", issue_key: "MUL-383", parent_issue: false };
function show(fields: Record<string, unknown> = {}) {
  return renderWithI18n(<WorkspaceSlugProvider slug="remi"><NavigationProvider value={{ pathname: "/remi/issues/current", push() {}, replace() {}, back() {}, searchParams: new URLSearchParams(), getShareableUrl: path => path }}>
    <MessageHeader message={messageFixture({ trigger_source: source, ...fields })} />
  </NavigationProvider></WorkspaceSlugProvider>, { locale: "zh-Hans" });
}
describe("message trigger source", () => {
  it("identifies the initiating comment, links to it and removes routing jargon", () => {
    const { container } = show();
    const link = screen.getByRole("link", { name: "由测试用户的评论触发" });
    expect(link).toHaveAttribute("href", "/remi/issues/iss_original?session=ises_original&comment=cmt_original");
    expect(container.textContent).not.toMatch(/收件人|仅收件箱|立即唤醒|状态/);
  });
  it("shows the actual parent agent name and parent Issue", () => {
    show({ trigger_source: { ...source, actor_type: "agent", actor_name: "父单 Agent", parent_issue: true } });
    expect(screen.getByText("由父单 Agent（父 Issue MUL-383）触发")).toBeInTheDocument();
  });
  it("identifies the named scheduled task", () => {
    show({ trigger_source: { ...source, actor_type: "timer", actor_name: "每日正式发布检查" } });
    expect(screen.getByText("由每日正式发布检查触发（定时）")).toBeInTheDocument();
  });
  it("does not guess a trigger for historical or malformed source information", () => {
    show({ trigger_source: { actor_name: "Wrong inferred owner" } });
    expect(screen.getByText("触发来源未记录")).toBeInTheDocument();
    expect(screen.queryByText(/Wrong inferred owner/)).toBeNull();
  });
  it("does not add redundant metadata to member comments", () => {
    const { container } = show({ sender_type: "member", author_type: "member" });
    expect(container.querySelector("[data-message-header]")).toBeNull();
  });
});
