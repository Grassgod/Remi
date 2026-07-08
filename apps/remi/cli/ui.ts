/**
 * Terminal UI helpers for CLI commands.
 * ANSI colors + formatting — zero dependencies.
 */

import * as readline from "node:readline";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const CYAN = `${ESC}36m`;

export function pass(msg: string): void {
  console.log(`  ${GREEN}✅${RESET} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠️${RESET}  ${msg}`);
}

export function fail(msg: string): void {
  console.log(`  ${RED}❌${RESET} ${msg}`);
}

export function header(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`);
}

export function step(current: number, total: number, msg: string): void {
  console.log(`\n${CYAN}[${current}/${total}]${RESET} ${BOLD}${msg}${RESET}`);
}

export function info(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`);
}

export function line(): void {
  console.log("─".repeat(40));
}

export function banner(title: string, version: string): void {
  console.log(`\n${BOLD}${title}${RESET} ${DIM}v${version}${RESET}`);
  console.log("─".repeat(40));
}

/**
 * Prompt user for input via readline.
 * Returns trimmed input. Empty string if user just presses Enter.
 */
export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
