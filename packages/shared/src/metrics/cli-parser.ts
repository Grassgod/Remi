/**
 * CliUsageScanner — Incremental parser for Claude CLI session JSONL files.
 *
 * Scans ~/.claude/projects/ * /*.jsonl for assistant messages containing
 * usage data, converts them to TokenMetricEntry format.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logger.js";
import type { TokenMetricEntry } from "./collector.js";

const log = createLogger("cli-parser");

/** Scan position tracking per file. */
interface ScanPositions {
  [filePath: string]: {
    offset: number;   // bytes already read
    mtime: number;    // last known mtime (ms)
  };
}

export class CliUsageScanner {
  private readonly _claudeDir: string;
  private readonly _positionsFile: string;
  private _positions: ScanPositions;

  constructor(metricsDir: string) {
    this._claudeDir = join(homedir(), ".claude");
    this._positionsFile = join(metricsDir, ".cli-scan-positions.json");
    this._positions = this._loadPositions();
  }

  /** Incremental scan — returns new entries since last scan. */
  scanNew(): TokenMetricEntry[] {
    const entries: TokenMetricEntry[] = [];
    const jsonlFiles = this._findJsonlFiles();

    for (const filePath of jsonlFiles) {
      try {
        const stat = statSync(filePath);
        const pos = this._positions[filePath];

        // Skip if file hasn't changed
        if (pos && stat.mtimeMs <= pos.mtime && stat.size <= pos.offset) {
          continue;
        }

        const startOffset = pos?.offset ?? 0;
        if (stat.size <= startOffset) continue;

        const newData = this._readFrom(filePath, startOffset, stat.size);
        const parsed = this._parseChunk(newData, filePath);
        entries.push(...parsed);

        this._positions[filePath] = {
          offset: stat.size,
          mtime: stat.mtimeMs,
        };
      } catch (e) {
        log.warn(`Failed to scan ${filePath}:`, e);
      }
    }

    this._savePositions();
    log.info(`CLI scan: found ${entries.length} new entries from ${jsonlFiles.length} files`);
    return entries;
  }

  /** Full scan for a date range — ignores positions. */
  scanRange(start: string, end: string): TokenMetricEntry[] {
    const entries: TokenMetricEntry[] = [];
    const jsonlFiles = this._findJsonlFiles();

    for (const filePath of jsonlFiles) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = this._parseChunk(raw, filePath);
        // Filter by date range
        entries.push(
          ...parsed.filter(e => {
            const d = e.ts.slice(0, 10);
            return d >= start && d <= end;
          }),
        );
      } catch (e) {
        log.warn(`Failed to read ${filePath}:`, e);
      }
    }

    return entries;
  }

  /** Find all JSONL files under ~/.claude/projects/ recursively. */
  private _findJsonlFiles(): string[] {
    const projectsDir = join(this._claudeDir, "projects");
    if (!existsSync(projectsDir)) return [];

    const files: string[] = [];
    this._walkDir(projectsDir, files);
    return files;
  }

  private _walkDir(dir: string, files: string[]): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          this._walkDir(fullPath, files);
        } else if (entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch {
      // permission denied or other error — skip
    }
  }

  /** Read file from a byte offset to end. */
  private _readFrom(filePath: string, offset: number, size: number): string {
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, buf.length, offset);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf-8");
  }

  /** Parse JSONL chunk, extracting assistant messages with usage data. */
  private _parseChunk(raw: string, filePath: string): TokenMetricEntry[] {
    const entries: TokenMetricEntry[] = [];

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;

      try {
        const obj = JSON.parse(line);

        // Only parse assistant messages with usage
        if (obj.type !== "assistant") continue;
        const usage = obj.message?.usage;
        if (!usage) continue;

        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const cacheCreate = usage.cache_creation_input_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;

        // Skip entries with zero tokens
        if (inputTokens === 0 && outputTokens === 0) continue;

        // Extract project from file path
        const project = this._extractProject(filePath);

        entries.push({
          ts: obj.timestamp ?? new Date().toISOString(),
          src: "cli",
          sid: obj.sessionId ?? null,
          model: obj.message?.model || null,
          in: inputTokens,
          out: outputTokens,
          cacheCreate,
          cacheRead,
          cost: null,  // CLI doesn't report cost
          dur: null,   // CLI doesn't report duration per message
          project,
          connector: null,
        });
      } catch {
        // skip malformed lines
      }
    }

    return entries;
  }

  /** Extract project path from JSONL file path. */
  private _extractProject(filePath: string): string | null {
    // Pattern: ~/.claude/projects/<encoded-path>/<session>.jsonl
    const projectsDir = join(this._claudeDir, "projects");
    const relative = filePath.slice(projectsDir.length + 1);
    const firstSlash = relative.indexOf("/");
    if (firstSlash === -1) return null;

    const encoded = relative.slice(0, firstSlash);
    // Claude CLI encodes paths by replacing / with -
    return encoded.replace(/-/g, "/");
  }

  private _loadPositions(): ScanPositions {
    if (!existsSync(this._positionsFile)) return {};
    try {
      return JSON.parse(readFileSync(this._positionsFile, "utf-8"));
    } catch {
      return {};
    }
  }

  private _savePositions(): void {
    try {
      writeFileSync(this._positionsFile, JSON.stringify(this._positions), "utf-8");
    } catch (e) {
      log.warn("Failed to save scan positions:", e);
    }
  }
}
