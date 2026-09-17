import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { ChatPendingTask, TaskMessagePayload } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import { TaskStatusPill } from "./task-status-pill";

function pill(pendingTask: ChatPendingTask, taskMessages: TaskMessagePayload[] = []) {
  return <I18nProvider locale="en" resources={{ en: { chat: enChat } }}>
    <TaskStatusPill pendingTask={pendingTask} taskMessages={taskMessages} availability="online" />
  </I18nProvider>;
}

describe("Chat preparation status", () => {
  it("shows preparation and completion summaries, then yields to live provider activity", () => {
    const pending = { task_id: "task-1", status: "running", progress_summary: "正在准备项目仓库…" };
    const view = render(pill(pending));
    expect(screen.getByText("正在准备项目仓库…")).toBeInTheDocument();
    view.rerender(pill({ ...pending, progress_summary: "项目仓库准备完成，正在启动智能体…" }));
    expect(screen.getByText("项目仓库准备完成，正在启动智能体…")).toBeInTheDocument();
    view.rerender(pill(pending, [{ task_id: "task-1", issue_id: "", seq: 1, type: "text", content: "Reply" }]));
    expect(screen.queryByText("正在准备项目仓库…")).not.toBeInTheDocument();
    expect(screen.getByText(enChat.status_pill.stages.typing)).toBeInTheDocument();
  });

  it("keeps original pure Chat and human/local-directory waiting labels", () => {
    const pending = { task_id: "task-1", status: "running" };
    const view = render(pill(pending));
    expect(screen.getByText(enChat.status_pill.stages.thinking)).toBeInTheDocument();
    for (const status of ["awaiting_human", "waiting_local_directory"] as const) {
      view.rerender(pill({ ...pending, status, progress_summary: "Old preparation status" }));
      expect(screen.queryByText("Old preparation status")).not.toBeInTheDocument();
      expect(screen.getByText(enChat.status_pill.stages[status])).toBeInTheDocument();
    }
  });

  it("uses the normal stage for absent, blank, or malformed optional summaries", () => {
    for (const progress_summary of [null, "   ", 17]) {
      const view = render(pill({ task_id: "task-1", status: "running", progress_summary } as ChatPendingTask));
      expect(screen.getByText(enChat.status_pill.stages.thinking)).toBeInTheDocument();
      view.unmount();
    }
  });
});
