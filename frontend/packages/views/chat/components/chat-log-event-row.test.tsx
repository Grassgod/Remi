import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { paths } from "@multiremi/core/paths";
import { renderWithI18n } from "../../test/i18n";
import { ChatLogEventRow } from "./chat-log-event-row";

vi.mock("@multiremi/core/paths", async importOriginal => ({
  ...await importOriginal<typeof import("@multiremi/core/paths")>(),
  useWorkspacePaths: () => paths.workspace("test"),
}));
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, className }: { href: string; children: React.ReactNode; className: string }) => <a href={href} className={className}>{children}</a>,
}));

const body = (status = "completed") => `MUL-501 有新日志：会话 ises_123，seq (0, 10]；本次轮次 tsk_123 状态 ${status}，原因 internal details`;

describe("Chat event rows", () => {
  it.each([
    ["done", "completed"], ["failed", "failed"], ["cancelled", "cancelled"],
  ])("links a %s progress report without showing internal protocol", (outcome, label) => {
    renderWithI18n(<ChatLogEventRow markdown={body()} metadata={{ envelope: { outcome, source: { issueId: "iss_501" } } }} />);
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent(`MUL-501 has new progress (${label})`);
    expect(link).toHaveAttribute("href", "/test/issues/iss_501");
    expect(link).toHaveClass("h-8", "truncate");
    expect(document.body).not.toHaveTextContent(/ises_|tsk_|seq|internal details/);
  });

  it("falls back to body key and outcome without querying an Issue", () => {
    renderWithI18n(<ChatLogEventRow markdown={body("failed")} metadata={{ envelope: false }} />);
    expect(screen.getByRole("status")).toHaveTextContent("MUL-501 has new progress (failed)");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps other events to one plain summary", () => {
    renderWithI18n(<ChatLogEventRow markdown={"# **Update** cmt_env_123 chat_456\nHidden second line"} />);
    expect(screen.getByRole("status")).toHaveTextContent("Update");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.body).not.toHaveTextContent(/cmt_env_|chat_|Hidden second/);
  });

  it.each(["en", "zh-Hans", "ja", "ko"] as const)("localizes progress notifications in %s", locale => {
    renderWithI18n(<ChatLogEventRow markdown={body()} />, { locale });
    expect(screen.getByRole("status")).toHaveTextContent("MUL-501");
    expect(document.body).not.toHaveTextContent("message_list.issue_update");
  });
});
