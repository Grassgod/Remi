// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { AgentTask } from "@multiremi/core/types";
import { renderWithI18n } from "../../test/i18n";
import { ExecutionModelInfo } from "./execution-model-info";

const task = {
  id: "task-1", agent_id: "agent-1", runtime_id: null, issue_id: "issue-1",
  status: "completed", priority: 0, dispatched_at: null, started_at: null,
  completed_at: null, result: null, error: null, created_at: "2026-09-19T00:00:00Z",
} satisfies AgentTask;

describe("ExecutionModelInfo", () => {
  it("prioritizes the task execution model and effort over the Agent's primary configuration", () => {
    renderWithI18n(<ExecutionModelInfo task={{ ...task, executionModel: "deepseek-flash", executionThinkingLevel: "high",
      fallbackSwitched: true, switchReason: "gateway_resource:agent_error.provider_no_available_account;provider_session_reset" }}
      agentModel="gpt-primary" agentThinkingLevel="low" />);
    expect(screen.getByText("deepseek-flash")).toBeInTheDocument();
    expect(screen.queryByText("gpt-primary")).toBeNull();
    expect(screen.getByText(/Switched from primary to fallback/)).toBeInTheDocument();
    expect(screen.getByText(/No available gateway account/)).toBeInTheDocument();
    expect(screen.getByText(/1 switch/)).toBeInTheDocument();
    expect(screen.getByText(/high/)).toBeInTheDocument();
  });

  it("uses the Agent model and effort for a legacy task", () => {
    renderWithI18n(<ExecutionModelInfo task={task} agentModel="gpt-primary" agentThinkingLevel="low" />);
    expect(screen.getByText("gpt-primary")).toBeInTheDocument();
    expect(screen.getByText(/low/)).toBeInTheDocument();
    expect(screen.queryByText(/Switched from primary/)).toBeNull();
  });

  it("does not borrow the Agent effort when legacy usage names a different model", () => {
    renderWithI18n(<ExecutionModelInfo task={task} usageModel="observed-backup"
      agentModel="current-primary" agentThinkingLevel="high" />);
    expect(screen.getByText("observed-backup")).toBeInTheDocument();
    expect(screen.queryByText("current-primary")).toBeNull();
    expect(screen.queryByText("(high)")).toBeNull();
  });

  it("retains the Agent effort when legacy usage names the same model", () => {
    renderWithI18n(<ExecutionModelInfo task={task} usageModel="current-primary"
      agentModel="current-primary" agentThinkingLevel="high" />);
    expect(screen.getByText("current-primary")).toBeInTheDocument();
    expect(screen.getByText("(high)")).toBeInTheDocument();
  });

  it("never attributes the primary effort to a switched task without an execution effort snapshot", () => {
    renderWithI18n(<ExecutionModelInfo task={{ ...task, execution_model: "deepseek-flash", fallback_switched: true }}
      agentModel="gpt-primary" agentThinkingLevel="low" />);
    expect(screen.getByText("deepseek-flash")).toBeInTheDocument();
    expect(screen.queryByText(/low/)).toBeNull();
  });

  it("ignores malformed optional execution fields and remains renderable", () => {
    renderWithI18n(<ExecutionModelInfo task={{ ...task, executionModel: 42 as unknown as string,
      switchReason: {} as string, fallbackSwitched: true }} />);
    expect(screen.getByText(/Resource unavailable/)).toBeInTheDocument();
  });
});
