import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Execution groups", () => {
  it("keeps default group IDs across display-name changes, restart and Runtime replacement", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Laptop", provider: "codex", daemonId: "machine" });
    const groupId = runtime.executionGroupIds![0]!;
    store.updateRuntime(runtime.id, { name: "Renamed" });
    const reopened = new MultiremiStore(db!);
    expect(reopened.getExecutionGroup(groupId)?.runtimeIds).toEqual([runtime.id]);
    const agent = reopened.createAgent({ name: "Grouped", provider: "codex", executionGroupId: groupId });
    reopened.registerRuntime({ name: "Peer engine", provider: "claude", daemonId: "machine" });
    expect(reopened.deleteRuntime(runtime.id)).toBe(true);
    expect(reopened.getExecutionGroup(groupId)?.runtimeIds).toEqual([]);
    expect(reopened.getAgent(agent.id)?.executionGroupId).toBe(groupId);
    const task = reopened.createTask({ agentId: agent.id, prompt: "Wait for the same machine" });
    const outsider = reopened.registerRuntime({ name: "Other", provider: "codex", daemonId: "other" });
    expect(reopened.claimTask(outsider.id)).toBeNull();
    const replacement = reopened.registerRuntime({ name: "Replacement", provider: "codex", daemonId: "machine" });
    expect(replacement.executionGroupIds).toEqual([groupId]);
    expect(reopened.claimTask(replacement.id)?.id).toBe(task.id);
  });

  it("preserves the default group when legacy registration gains its daemon identity", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "legacy", name: "Legacy", provider: "codex" });
    const groupId = runtime.executionGroupIds![0]!;
    const pinned = store.createAgent({ name: "Pinned", provider: "codex", runtimeId: runtime.id });
    const grouped = store.createAgent({ name: "Grouped", provider: "codex", executionGroupId: groupId });
    const task = store.createTask({ agentId: pinned.id, prompt: "Before registration upgrade" });
    const upgraded = store.registerRuntime({ id: runtime.id, name: "Named", provider: "codex", daemonId: "machine" });
    expect(upgraded.executionGroupIds).toEqual([groupId]);
    expect(store.getAgent(grouped.id)?.executionGroupId).toBe(groupId);
    expect(store.getExecutionGroup(groupId)?.machineId).toBe("machine");
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    const sibling = store.registerRuntime({ name: "Second Runtime", provider: "codex", daemonId: "machine" });
    expect(sibling.executionGroupIds).toEqual([groupId]);
  });

  it("preserves a temporarily empty default group when identity is learned while using a custom group", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "legacy", name: "Legacy", provider: "codex" });
    const defaultId = runtime.executionGroupIds![0]!;
    const agent = store.createAgent({ name: "Default worker", provider: "codex", executionGroupId: defaultId });
    store.updateRuntime(runtime.id, { executionGroupId: "custom" });
    const customAgent = store.createAgent({ name: "Custom worker", provider: "codex", executionGroupId: "custom" });
    store.registerRuntime({ id: runtime.id, name: "Identified", provider: "codex", daemonId: "machine" });
    expect(store.getAgent(customAgent.id)?.executionGroupId).toBe("custom");
    expect(store.getExecutionGroup(defaultId)).toMatchObject({ machineId: "machine", runtimeIds: [] });
    const restored = store.updateRuntime(runtime.id, { executionGroupId: null });
    expect(restored.executionGroupIds).toEqual([defaultId]);
    const task = store.createTask({ agentId: agent.id, prompt: "Default target restored" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  });

  it("pools custom groups across machines, keeps types and workspaces isolated, and rejects reserved IDs", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex", daemonId: "a", executionGroupId: "company-code" });
    const second = store.registerRuntime({ name: "B", provider: "codex", daemonId: "b", executionGroupId: "company-code" });
    const other = store.registerRuntime({ name: "C", provider: "codex", daemonId: "c" });
    expect(store.getExecutionGroup("company-code")?.runtimeIds.sort()).toEqual([first.id, second.id].sort());
    expect(() => store.registerRuntime({ name: "Wrong type", provider: "claude", executionGroupId: "company-code" })).toThrow("provider");
    expect(() => store.updateRuntime(other.id, { executionGroupId: first.executionGroupIds![0]!.replace("company-code", "eg_reserved") })).toThrow("reserved");
    expect(() => store.registerRuntime({ name: "Any", provider: "any", executionGroupId: "custom" })).toThrow("concrete");
    store.createWorkspace({ id: "team", name: "Team", slug: "team" });
    const foreign = store.registerRuntime({ name: "Foreign", provider: "claude", workspaceId: "team", executionGroupId: "company-code" });
    expect(store.getExecutionGroup("company-code", "team")?.runtimeIds).toEqual([foreign.id]);
    const agent = store.createAgent({ name: "Worker", provider: "codex", executionGroupId: "company-code" });
    const task = store.createTask({ agentId: agent.id, prompt: "group only" });
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.claimTask(second.id)?.id).toBe(task.id);
  });

  it("preserves custom assignment on registration and restores the original default ID on clear", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Machine", provider: "codex", daemonId: "a" });
    const defaultId = runtime.executionGroupIds![0]!;
    store.updateRuntime(runtime.id, { executionGroupId: "custom" });
    const refreshed = store.registerRuntime({ id: runtime.id, name: "Restart", provider: "codex", daemonId: "a" });
    expect(refreshed.executionGroupIds).toEqual(["custom"]);
    const restored = store.updateRuntime(runtime.id, { executionGroupId: null });
    expect(restored.executionGroupIds).toEqual([defaultId]);
    expect(store.getExecutionGroup("custom")?.runtimeIds).toEqual([]);
  });

  it("rechecks model evidence per member and does not block other Agents", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex", executionGroupId: "custom", models: [{ id: "a-model", label: "A", provider: "codex", default: true }] });
    const second = store.registerRuntime({ name: "B", provider: "codex", executionGroupId: "custom", models: [{ id: "b-model", label: "B", provider: "codex", default: true }] });
    const agentA = store.createAgent({ name: "A", provider: "codex", executionGroupId: "custom", model: "a-model" });
    const agentB = store.createAgent({ name: "B", provider: "codex", executionGroupId: "custom", model: "b-model" });
    const taskA = store.createTask({ agentId: agentA.id, prompt: "A" });
    const taskB = store.createTask({ agentId: agentB.id, prompt: "B" });
    expect(store.claimTask(second.id)?.id).toBe(taskB.id);
    expect(store.claimTask(first.id)?.id).toBe(taskA.id);
    store.cancelTask(taskA.id);
    store.updateRuntime(first.id, { models: [] });
    const queued = store.createTask({ agentId: agentA.id, prompt: "No evidence" });
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.getTask(queued.id)?.status).toBe("queued");
  });

  it("uses vendor model catalogs and rechecks reasoning support including default-model selections", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Vendor", provider: "codex", executionGroupId: "vendor", models: [{
      id: "gpt-model", label: "GPT", provider: "openai", default: true,
      thinking: { supportedLevels: [{ value: "high", label: "High" }] },
    }] });
    const agent = store.createAgent({ name: "Reasoner", provider: "codex", executionGroupId: "vendor", thinkingLevel: "high" });
    const first = store.createTask({ agentId: agent.id, prompt: "Uses default" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    store.cancelTask(first.id);
    store.updateRuntime(runtime.id, { models: [{ id: "gpt-model", label: "GPT", provider: "openai", default: true }] });
    const next = store.createTask({ agentId: agent.id, prompt: "Reasoning disappeared" });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(next.id)?.status).toBe("queued");
    store.updateAgent(agent.id, { model: "gpt-model", thinkingLevel: null });
    expect(store.claimTask(runtime.id)?.id).toBe(next.id);
  });

  it("leaves work in its group when a member departs and migrates legacy pins without weakening them", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex", daemonId: "a", executionGroupId: "original" });
    const second = store.registerRuntime({ name: "B", provider: "codex", daemonId: "b", executionGroupId: "original" });
    const legacy = store.createAgent({ name: "Legacy", provider: "codex", runtimeId: first.id });
    db!.run("UPDATE multiremi_agents SET execution_group_id = NULL WHERE id = ?", [legacy.id]);
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", ["execution_groups_v1"]);
    const reopened = new MultiremiStore(db!);
    expect(reopened.getAgent(legacy.id)).toMatchObject({ runtimeId: first.id, executionGroupId: "original" });
    const task = reopened.createTask({ agentId: legacy.id, prompt: "Legacy remains pinned" });
    expect(reopened.claimTask(second.id)).toBeNull();
    reopened.updateAgent(legacy.id, { executionGroupId: "original" });
    expect(reopened.getAgent(legacy.id)?.runtimeId).toBeNull();
    reopened.updateRuntime(first.id, { executionGroupId: "departed" });
    expect(reopened.claimTask(first.id)).toBeNull();
    expect(reopened.claimTask(second.id)?.id).toBe(task.id);
  });

  it("reclaims a lost dispatch only within its group after the original member leaves", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex", executionGroupId: "original" });
    const second = store.registerRuntime({ name: "B", provider: "codex", executionGroupId: "original" });
    const agent = store.createAgent({ name: "Worker", provider: "codex", executionGroupId: "original" });
    const task = store.createTask({ agentId: agent.id, prompt: "Lost claim response" });
    expect(store.claimTask(first.id)?.id).toBe(task.id);
    store.updateRuntime(first.id, { executionGroupId: "departed" });
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.claimTask(second.id)?.id).toBe(task.id);
  });

  it("releases queued session affinity when registration moves a member into another group", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex", executionGroupId: "original" });
    const second = store.registerRuntime({ name: "B", provider: "codex", executionGroupId: "original" });
    const agent = store.createAgent({ name: "Worker", provider: "codex", executionGroupId: "original" });
    const task = store.createTask({ agentId: agent.id, runtimeId: first.id, prompt: "Queued affinity" });
    expect(task.runtimeId).toBe(first.id);
    store.registerRuntime({ id: first.id, name: "Moved", provider: "codex", executionGroupId: "departed" });
    expect(store.getTask(task.id)?.runtimeId).toBeNull();
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.claimTask(second.id)?.id).toBe(task.id);
  });

  it("cancels a frozen dispatch when its Agent switches groups", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex", executionGroupId: "original" });
    const second = store.registerRuntime({ name: "B", provider: "codex", executionGroupId: "target" });
    const agent = store.createAgent({ name: "Worker", provider: "codex", executionGroupId: "original" });
    const task = store.createTask({ agentId: agent.id, prompt: "Not started" });
    expect(store.claimTask(first.id)?.id).toBe(task.id);
    store.updateAgent(agent.id, { executionGroupId: "target" });
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.claimTask(second.id)).toBeNull();
  });

  it("migrates both binding forms when a legacy identity joins an existing default group", () => {
    const store = createStore();
    const canonical = store.registerRuntime({ name: "Canonical", provider: "codex", daemonId: "machine" });
    const legacy = store.registerRuntime({ id: "legacy", name: "Legacy", provider: "codex" });
    const agent = store.createAgent({ name: "Grouped", provider: "codex", executionGroupId: legacy.executionGroupIds![0] });
    const pinned = store.createAgent({ name: "Pinned", provider: "codex", runtimeId: legacy.id });
    store.registerRuntime({ id: legacy.id, name: "Upgrade", provider: "codex", daemonId: "machine" });
    expect(store.getAgent(agent.id)?.executionGroupId).toBe(canonical.executionGroupIds![0]);
    expect(store.getAgent(pinned.id)).toMatchObject({ runtimeId: legacy.id, executionGroupId: canonical.executionGroupIds![0] });
    expect(store.getExecutionGroup(canonical.executionGroupIds![0]!)?.runtimeIds.sort()).toEqual([canonical.id, legacy.id].sort());
  });

  it("creates one default group per concrete engine for a legacy any Runtime", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Legacy", provider: "any", daemonId: "a" });
    const groups = store.listExecutionGroups("local");
    expect(groups.map(group => group.provider).sort()).toEqual(["claude", "codex"]);
    expect(runtime.executionGroupIds).toHaveLength(2);
  });
});
