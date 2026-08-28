/**
 * Remi core — slash-command handling.
 *
 * The `/clear`, `/new`, `/project`, `/p`, `/context`, `/compact`, `/sessions`
 * and `/status` command table was moved out of
 * `core.ts`; `processStream` calls `tryCommand` before routing to a provider.
 */

import { existsSync } from "node:fs";
import type { Remi } from "../core.js";
import type { IncomingMessage } from "@connectors/base.js";
import { type AgentResponse, type Provider } from "@shared/contracts/provider-types.js";
import * as sessDb from "@shared/db/sessions.js";

const COMMANDS = new Set(["clear", "new", "status", "project", "p", "context", "compact", "sessions"]);

export async function tryCommand(remi: Remi, text: string, msg: IncomingMessage): Promise<AgentResponse | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();

  if (!COMMANDS.has(name)) return null; // Unknown command → pass to provider

  const sessionKey = remi._resolveSessionKey(msg);
  const isThread = sessionKey !== msg.chatId;

  switch (name) {
    case "clear":
    case "new": {
      sessDb.clearSessionId(sessionKey);
      // Also clear the underlying provider's conversation context
      const provider = remi._getProvider();
      if ("clearSession" in provider && typeof provider.clearSession === "function") {
        await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
      }
      return { text: "上下文已清除，开始新对话。" };
    }
    case "project":
    case "p": {
      const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (!arg) {
        const projects = remi._listBotProjects();
        if (!projects) {
          return { text: "项目目录暂不可用，请检查 Multiremi daemon 连接。" };
        }
        const currentCwd = sessDb.getSession(sessionKey)?.cwd ?? undefined;
        const lines = [`当前目录: ${currentCwd ?? "未绑定（使用 agent 默认目录）"}`];
        if (projects.length > 0) {
          lines.push("", "可用项目:");
          for (const p of projects) {
            const marker = currentCwd === p.cwd ? " ◀" : "";
            lines.push(`  ${p.id}  ${p.title}  →  ${p.cwd}${marker}`);
          }
        } else {
          lines.push("", "当前运行节点没有可切换的 Multiremi 项目目录。");
        }
        return { text: lines.join("\n") };
      }

      if (arg === "reset") {
        sessDb.updateSessionCwd(sessionKey, null);
        sessDb.clearSessionId(sessionKey);
        const provider = remi._getProvider();
        if ("clearSession" in provider && typeof provider.clearSession === "function") {
          await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
        }
        return { text: "已清除项目绑定，下条消息将在 agent 默认目录启动。" };
      }

      const projects = remi._listBotProjects();
      if (!projects) {
        return { text: "项目目录暂不可用，请检查 Multiremi daemon 连接。" };
      }
      const matched = remi._getBotProject(arg);
      if (!matched) {
        return { text: "项目不存在，或未绑定到当前运行节点。请用 /p 查看可用项目。" };
      }
      const targetPath = matched.cwd;

      if (!existsSync(targetPath)) {
        return { text: "项目目录在当前运行节点上不存在，请检查项目资源配置。" };
      }

      // Kill old process, bind new cwd
      sessDb.updateSessionCwd(sessionKey, targetPath);
      sessDb.clearSessionId(sessionKey);
      const provider = remi._getProvider();
      if ("clearSession" in provider && typeof provider.clearSession === "function") {
        await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
      }

      return { text: `项目已切换: ${matched.title} (${matched.id})\n下条消息将在 ${targetPath} 启动 agent。` };
    }
    case "context": {
      // Forward /context to CLI to get detailed context usage breakdown
      const provider = remi._getProvider();
      try {
        const resp = await provider.send("/context", { chatId: sessionKey, sessionId: sessDb.getSessionId(sessionKey) ?? undefined });
        return { text: resp.text || "无法获取 context 信息" };
      } catch {
        return { text: "无法获取 context 信息，当前会话可能未启动。" };
      }
    }
    case "compact": {
      // Forward /compact to CLI to compress conversation context
      const provider = remi._getProvider();
      try {
        const resp = await provider.send("/compact", { chatId: sessionKey, sessionId: sessDb.getSessionId(sessionKey) ?? undefined });
        return { text: resp.text || "Compact 完成" };
      } catch {
        return { text: "Compact 失败，当前会话可能未启动。" };
      }
    }
    case "sessions": {
      const allActive = sessDb.listActiveSessions();
      if (allActive.length === 0) {
        return { text: "当前无活跃 session。" };
      }
      const lines = [`**活跃 Sessions** (${allActive.length}):`];
      for (const s of allActive) {
        const isCurrent = s.session_key === sessionKey;
        const time = new Date(s.last_active);
        const hh = String(((time.getUTCHours() + 8) % 24)).padStart(2, "0");
        const mm = String(time.getUTCMinutes()).padStart(2, "0");
        lines.push(`  ${s.display_name} | ${hh}:${mm} | ${s.session_id ? s.session_id.slice(0, 8) : "new"}${isCurrent ? " ← 当前" : ""}`);
      }
      return { text: lines.join("\n") };
    }
    case "status": {
      const statusRow = sessDb.getSession(sessionKey);
      const providers = [...remi._providers.keys()].join(", ");
      const connectors = remi._connectors.map((c) => c.name).join(", ");
      const lines = [
        `**Remi Status**`,
        `- Session: ${statusRow?.session_id ? statusRow.session_id.slice(0, 12) + "..." : "无"}`,
        statusRow?.display_name ? `- Name: ${statusRow.display_name}` : "",
        isThread ? `- Context: Thread (isolated)` : `- Context: Main chat`,
        statusRow?.cwd ? `- Project: ${statusRow.cwd}` : `- Project: ~ (默认)`,
        `- Providers: ${providers}`,
        `- Connectors: ${connectors}`,
      ].filter(Boolean);
      if (remi.authStore) {
        for (const s of remi.authStore.status()) {
          const ttl = Math.round((s.expiresAt - Date.now()) / 1000 / 60);
          lines.push(
            `- Token ${s.service}/${s.type}: ${s.valid ? `valid (${ttl}min)` : "expired"}`,
          );
        }
      }
      return { text: lines.join("\n") };
    }
    default:
      return null;
  }
}
