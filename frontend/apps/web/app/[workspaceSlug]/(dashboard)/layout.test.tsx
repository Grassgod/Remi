import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const route = vi.hoisted(() => ({ pathname: "/demo/chat" }));
vi.mock("@multiremi/views/navigation", () => ({ useNavigation: () => ({ pathname: route.pathname }) }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({ chat: () => "/demo/chat" }),
}));
vi.mock("@multiremi/views/layout", () => ({
  DashboardLayout: ({
    children,
    extra,
  }: {
    children: ReactNode;
    extra: ReactNode;
  }) => (
    <>
      {children}
      {extra}
    </>
  ),
}));
vi.mock("@multiremi/ui/components/common/multimira-icon", () => ({
  MultiremiIcon: () => null,
}));
vi.mock("@multiremi/views/search", () => ({
  SearchCommand: () => null,
  SearchTrigger: () => null,
}));
vi.mock("@multiremi/views/chat", () => ({
  ChatWindow: () => <div data-testid="floating-chat" />,
  ChatFab: () => <div data-testid="chat-fab" />,
}));
import Layout from "./layout";
describe("dashboard chat placement", () => {
  it("mounts only the page conversation on the chat route", () => {
    route.pathname = "/demo/chat";
    render(
      <Layout>
        <div data-testid="chat-page" />
      </Layout>,
    );
    expect(screen.getByTestId("chat-page")).toBeInTheDocument();
    expect(screen.queryByTestId("floating-chat")).toBeNull();
    expect(screen.queryByTestId("chat-fab")).toBeNull();
  });
  it("preserves floating chat on other workspace routes", () => {
    route.pathname = "/demo/issues";
    render(
      <Layout>
        <div />
      </Layout>,
    );
    expect(screen.getByTestId("floating-chat")).toBeInTheDocument();
    expect(screen.getByTestId("chat-fab")).toBeInTheDocument();
  });
});
