import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentAvailability } from "@multiremi/core/agents";
import type { ChatPendingTask, TaskMessagePayload } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import { TaskStatusPill } from "./task-status-pill";

function pill(pendingTask: ChatPendingTask, taskMessages: TaskMessagePayload[] = [], availability: AgentAvailability = "online") {
  return <I18nProvider locale="en" resources={{ en: { chat: enChat } }}>
    <TaskStatusPill pendingTask={pendingTask} taskMessages={taskMessages} availability={availability} />
  </I18nProvider>;
}

describe("Chat preparation status", () => {
  it("shows the queued reason without presenting a human request and clears it after recovery", () => {
    const wait_reason = "等待模型能力恢复：2 个候选 Runtime 均无法执行 claude-opus-5";
    const pending = { task_id: "task-1", status: "queued", wait_reason };
    const view = render(pill(pending));
    expect(screen.getByText(enChat.status_pill.stages.queued)).toBeInTheDocument();
    expect(screen.getByText(wait_reason)).toBeInTheDocument();
    expect(screen.queryByText(enChat.status_pill.stages.awaiting_human)).not.toBeInTheDocument();
    view.rerender(pill({ ...pending, wait_reason: null }));
    expect(screen.queryByText(wait_reason)).not.toBeInTheDocument();
    view.rerender(pill({ ...pending, status: "running" }));
    expect(screen.queryByText(wait_reason)).not.toBeInTheDocument();
    expect(screen.getByText(enChat.status_pill.stages.thinking)).toBeInTheDocument();
  });

  it("ignores malformed reasons and preserves the human and directory waiting labels", () => {
    for (const wait_reason of [null, undefined, 17, {}, "  "]) {
      const view = render(pill({ task_id: "task-1", status: "queued", wait_reason } as ChatPendingTask));
      expect(screen.getByText(enChat.status_pill.stages.queued)).toBeInTheDocument();
      view.unmount();
    }
    for (const status of ["awaiting_human", "waiting_local_directory"] as const) {
      const view = render(pill({ task_id: "task-1", status, wait_reason: "Private waiting detail" }));
      expect(screen.getByText(enChat.status_pill.stages[status])).toBeInTheDocument();
      expect(screen.queryByText("Private waiting detail")).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it.each(["offline", "unstable"] as const)("keeps a task-specific queued explanation when agent availability is %s", availability => {
    const wait_reason = "Waiting for model support";
    render(pill({ task_id: "task-1", status: "queued", wait_reason }, [], availability));
    expect(screen.getByText(enChat.status_pill.stages.queued)).toBeInTheDocument();
    expect(screen.getByText(wait_reason)).toBeInTheDocument();
  });

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
