/**
 * Dynamic P2P bot menu generator.
 *
 * Generates 5-column menu layout:
 * 1. Commands — system-level slash commands
 * 2. Switch — provider:mode combinations
 * 3. Projects — from config.projects + reset
 * 4. Skills — discovered from ~/.remi/.claude/skills/
 * 5. Navigate — Dashboard and external links
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BotMenuItemConfig } from "../../config.js";

/** Parse SKILL.md frontmatter to extract skill name. */
function parseSkillName(skillDir: string): string | null {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) return null;
  try {
    const content = readFileSync(skillMd, "utf-8");
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)/m);
    return nameMatch ? nameMatch[1].trim() : null;
  } catch {
    return null;
  }
}

/** Discover skills from a directory. Returns array of skill names. */
function discoverSkills(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => parseSkillName(join(dir, d.name)) ?? d.name)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sendMsg(name: string): BotMenuItemConfig {
  return { name, behaviors: [{ type: "send_message" }] };
}

function linkItem(name: string, url: string): BotMenuItemConfig {
  return { name, behaviors: [{ type: "target", url, isPrimary: true }] };
}

export interface MenuGeneratorOptions {
  projects: Record<string, string>;
  dashboardUrl?: string;
  /** Extra static menu items to append (from remi.toml bot_menu config). */
  extraItems?: BotMenuItemConfig[];
}

export function generateP2PMenu(options: MenuGeneratorOptions): BotMenuItemConfig[] {
  const { projects, dashboardUrl } = options;

  // Column 1: Commands
  const commands: BotMenuItemConfig = {
    name: "Commands",
    i18nName: { en_us: "Commands", zh_cn: "命令" },
    icon: { token: "menu_outlined", color: "green" },
    children: [
      sendMsg("/clear"),
      sendMsg("/status"),
      sendMsg("/context"),
      sendMsg("/restart"),
      sendMsg("/esc"),
    ],
  };

  // Column 2: Switch (provider:mode combos)
  const switchMenu: BotMenuItemConfig = {
    name: "Switch",
    i18nName: { en_us: "Switch", zh_cn: "切换" },
    icon: { token: "switch_outlined", color: "blue" },
    children: [
      sendMsg("/switch claude:bypass"),
      sendMsg("/switch claude:plan"),
      sendMsg("/switch claude:auto"),
      sendMsg("/switch aiden:agentFull"),
      sendMsg("/switch aiden:plan"),
    ],
  };

  // Column 3: Projects
  const projectItems: BotMenuItemConfig[] = Object.keys(projects).map(alias =>
    sendMsg(`/project ${alias}`),
  );
  projectItems.push(sendMsg("/project reset"));

  const projectMenu: BotMenuItemConfig = {
    name: "Projects",
    i18nName: { en_us: "Projects", zh_cn: "项目" },
    icon: { token: "folder_outlined", color: "orange" },
    children: projectItems.slice(0, 10), // max 10 sub-items
  };

  // Column 4: Skills (discovered from ~/.remi/.claude/skills/)
  const skillDir = join(homedir(), ".remi", ".claude", "skills");
  const skillNames = discoverSkills(skillDir);
  const skillItems = skillNames.map(name => sendMsg(`/${name}`));

  const skillMenu: BotMenuItemConfig = {
    name: "Skills",
    i18nName: { en_us: "Skills", zh_cn: "技能" },
    icon: { token: "app_outlined", color: "turquoise" },
    children: skillItems.slice(0, 10),
  };

  // Column 5: Navigate
  const navChildren: BotMenuItemConfig[] = [];
  if (dashboardUrl) {
    navChildren.push(linkItem("Dashboard", dashboardUrl));
  }
  // Append any extra static items from config
  if (options.extraItems) {
    navChildren.push(...options.extraItems);
  }

  const navMenu: BotMenuItemConfig = {
    name: "Navigate",
    i18nName: { en_us: "Navigate", zh_cn: "导航" },
    icon: { token: "home_outlined", color: "purple" },
    ...(navChildren.length > 0 ? { children: navChildren } : { behaviors: [{ type: "target", url: dashboardUrl ?? "http://10.37.66.8:6120", isPrimary: true }] }),
  };

  return [commands, switchMenu, projectMenu, skillMenu, navMenu];
}
