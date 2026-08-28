import { describe, expect, it } from "bun:test";
import type {
  BotMenuConfig,
  MultiremiUser,
  MultiremiWorkspaceMember,
} from "@multiremi/contracts/types.js";
import {
  BotMenuConfigError,
  parseBotMenuConfig,
  resolveBotMenuConfig,
} from "../../../packages/server/src/bot-menu/config.js";

function item(name: string) {
  return { name, behaviors: [{ type: "send_message" as const }] };
}

function member(
  id: string,
  userId: string | null,
  role: "owner" | "admin" | "member",
): MultiremiWorkspaceMember {
  return {
    id,
    workspaceId: "ws-menu",
    userId,
    name: id,
    email: null,
    role,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function user(id: string, externalId: string | null): MultiremiUser {
  return {
    id,
    externalId,
    external_id: externalId,
    name: id,
    email: `${id}@example.test`,
    avatarUrl: null,
    avatar_url: null,
    language: null,
    timezone: null,
    onboardedAt: null,
    onboarded_at: null,
    onboardingQuestionnaire: {},
    onboarding_questionnaire: {},
    starterContentState: null,
    starter_content_state: null,
    profileDescription: "",
    profile_description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("workspace bot menu config", () => {
  it("accepts two menu levels and rejects a third", () => {
    expect(parseBotMenuConfig({
      default: [{ name: "Parent", children: [item("Child")] }],
    }).default?.[0]?.children?.[0]?.name).toBe("Child");

    expect(() => parseBotMenuConfig({
      default: [{
        name: "Parent",
        children: [{ name: "Child", children: [item("Too deep")] }],
      }],
    })).toThrow("exceeds two menu levels");
  });

  it("resolves roles to Feishu open_id and lets explicit targets override roles", () => {
    const members = [
      member("mem-owner", "usr-owner", "owner"),
      member("mem-member", "usr-member", "member"),
      member("mem-unlinked", "usr-unlinked", "member"),
    ];
    const users = new Map([
      ["usr-owner", user("usr-owner", "ou_owner")],
      ["usr-member", user("usr-member", "ou_member")],
      ["usr-unlinked", user("usr-unlinked", null)],
    ]);
    const config: BotMenuConfig = {
      users: [
        { target: { type: "member", memberId: "mem-member" }, items: [item("Explicit")] },
        { target: { type: "role", role: "member" }, items: [item("Member role")] },
        { target: { type: "external", userId: "union-advanced", userIdType: "union_id" }, items: [item("Advanced")] },
      ],
    };

    const resolved = resolveBotMenuConfig(config, "ws-menu", members, (id) => users.get(id) ?? null);

    expect(resolved.users).toEqual([
      { userId: "ou_member", userIdType: "open_id", items: [item("Explicit")] },
      { userId: "union-advanced", userIdType: "union_id", items: [item("Advanced")] },
    ]);
  });

  it("fails when an explicitly selected member has no linked Feishu identity", () => {
    const config: BotMenuConfig = {
      users: [{ target: { type: "member", memberId: "mem-member" }, items: [item("Menu")] }],
    };

    expect(() => resolveBotMenuConfig(
      config,
      "ws-menu",
      [member("mem-member", "usr-member", "member")],
      () => user("usr-member", null),
    )).toThrow(BotMenuConfigError);
  });
});
