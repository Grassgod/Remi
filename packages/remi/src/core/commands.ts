/**
 * Remi core — slash-command handling.
 *
 * The `/clear`, `/new`, `/switch`, `/restart`, `/project`, `/p`, `/context`,
 * `/compact`, `/sessions` and `/status` command table was moved verbatim out of
 * `core.ts`; `processStream` calls `tryCommand` before routing to a provider.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Remi } from "../core.js";
import { ProjectStore } from "../project/store.js";
import type { IncomingMessage } from "@connectors/base.js";
import { type AgentResponse, type Provider } from "@shared/contracts/provider-types.js";
import type { SessionModeState } from "@shared/contracts/acp-protocol.js";
import * as sessDb from "@shared/db/sessions.js";
import {
  availableSwitchModes,
  buildSwitchTarget,
  defaultSwitchMode,
  isKnownSwitchMode,
  parseSwitchArgs,
  providerLabel,
  resolveSwitchProviderAlias,
} from "@acp/switch-mode.js";

const COMMANDS = new Set(["clear", "new", "status", "restart", "project", "p", "context", "compact", "switch", "sessions"]);

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
    case "switch": {
      const groupCfg = remi._getGroupConfig(msg.chatId);
      if (groupCfg?.provider) {
        return { text: `此群 provider 已由管理员固定为 ${providerLabel(groupCfg.provider)}，无法通过 /switch 切换。` };
      }
      const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (!args) {
        // Show current state + available options
        const switchSessRow = sessDb.getSession(sessionKey);
        const curProvider = resolveSwitchProviderAlias(switchSessRow?.provider ?? `acp:${remi.config.provider.default}`);
        const curMode = switchSessRow?.mode ?? defaultSwitchMode(curProvider) ?? "agent default";
        const lines = [
          `当前: **${providerLabel(curProvider)} · ${curMode === "bypassPermissions" ? "bypass" : curMode}**`,
          "",
          "可用组合:",
          "  `/switch claude` 或 `/switch claude:auto` — ACP Claude Auto（默认，若 agent 不支持会回退 default）",
          "  `/switch claude:default` — ACP Claude 标准权限确认",
          "  `/switch claude:acceptEdits` — ACP Claude 自动接受编辑",
          "  `/switch claude:plan` — ACP Claude Plan 模式",
          "  `/switch claude:dontAsk` — ACP Claude 不询问，未预批准则拒绝",
          "  `/switch claude:bypass` — ACP Claude 跳过权限检查",
          "  `/switch cli:bypass` — 旧 Claude CLI 全权限",
        ];
        if (remi._providers.has("acp:codex")) {
          lines.push("  `/switch codex[:mode]` — ACP Codex（mode 由 agent 定义）");
        }
        return { text: lines.join("\n") };
      }

      // Parse provider:mode. Use the last colon so "acp:claude:auto" also works.
      const { providerAlias, modeArg } = parseSwitchArgs(args);
      const target = buildSwitchTarget(providerAlias, modeArg);
      const providerName = target.providerName;
      let provider: Provider;
      try {
        provider = remi._getProvider(providerName);
      } catch {
        return { text: `Provider "${providerAlias}" 不可用。可选: claude, codex, cli` };
      }

      // The agent's own list wins when we already have a live session for
      // this chat: claude only advertises `bypassPermissions` off-root and
      // `auto` on models that support it, and codex uses entirely different ids.
      const advertised = (provider as Provider & {
        advertisedModes?: (chatId: string) => SessionModeState | undefined;
      }).advertisedModes?.(sessionKey);
      if (target.mode && !isKnownSwitchMode(providerName, target.mode, advertised)) {
        const available = availableSwitchModes(providerName, advertised).join(", ");
        return { text: `模式 "${modeArg}" 对 ${providerLabel(providerName)} 不可用。可选: ${available}` };
      }

      const curProviderName = resolveSwitchProviderAlias(sessDb.getSession(sessionKey)?.provider ?? `acp:${remi.config.provider.default}`);
      const providerChanged = curProviderName !== providerName;

      if (providerChanged) {
        // Switching provider — clear old session (sessionId is provider-specific)
        let oldProvider: Provider | null = null;
        try { oldProvider = remi._getProvider(curProviderName); } catch {}
        if (oldProvider && "clearSession" in oldProvider && typeof (oldProvider as any).clearSession === "function") {
          await (oldProvider as any).clearSession(sessionKey);
        }
        sessDb.clearSessionId(sessionKey);
      } else {
        // Same provider, mode change only — kill process but keep sessionId for resume
        if (provider && "clearSession" in provider && typeof (provider as any).clearSession === "function") {
          await (provider as any).clearSession(sessionKey);
        }
        // Don't clear session — preserve sessionId for --resume
      }

      sessDb.upsertSessionSettings(sessionKey, {
        provider: providerName,
        mode: target.storedMode,
        clearSessionId: providerChanged,
      });

      const resumeNote = !providerChanged ? "（上下文保留）" : "（新对话）";
      return { text: `已切换到 **${providerLabel(providerName)} · ${target.modeLabel}** ${resumeNote}` };
    }
    case "restart": {
      // Delay restart so the response gets sent first
      if (remi._onRestart) {
        const info = { chatId: msg.chatId, connectorName: msg.connectorName };
        setTimeout(() => remi._onRestart!(info), 500);
      }
      return { text: "正在重启 Remi..." };
    }
    case "project":
    case "p": {
      const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
      const projectStore = new ProjectStore();

      if (!arg) {
        // Show current project + list
        const currentCwd = sessDb.getSession(sessionKey)?.cwd ?? undefined;
        const projects = projectStore.list().filter((p) => p.cwd);
        const lines = [`📍 当前: ${currentCwd ?? "~ (默认)"}`];
        if (projects.length > 0) {
          lines.push("", "可用项目:");
          for (const p of projects) {
            const marker = currentCwd === p.cwd ? " ◀" : "";
            lines.push(`  ${p.id}  →  ${p.cwd}${marker}`);
          }
        } else {
          lines.push("", "暂无注册项目，请在 Dashboard → Projects 中添加。");
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
        return { text: "已清除项目绑定，下条消息将在默认目录启动。" };
      }

      // Resolve alias or direct path
      let targetPath: string;
      const matched = projectStore.getById(arg);
      if (matched?.cwd) {
        targetPath = matched.cwd;
      } else {
        // Treat as direct path, expand ~
        targetPath = arg.startsWith("~") ? arg.replace("~", homedir()) : resolve(arg);
      }

      if (!existsSync(targetPath)) {
        return { text: `路径不存在: ${targetPath}` };
      }

      // Kill old process, bind new cwd
      remi._configManager?.ensureForCwd(targetPath);
      sessDb.updateSessionCwd(sessionKey, targetPath);
      sessDb.clearSessionId(sessionKey);
      const provider = remi._getProvider();
      if ("clearSession" in provider && typeof provider.clearSession === "function") {
        await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
      }

      // Find alias name for display
      const aliasName = matched?.id ?? projectStore.list().find((p) => p.cwd === targetPath)?.id;
      return { text: `项目已切换: ${aliasName ? `${aliasName} (${targetPath})` : targetPath}\n下条消息将在新目录启动 Claude。` };
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

