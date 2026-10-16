/**
 * The daemon's side of the task context file (PR 6 §2.4, see
 * `@shared/task-context-file`): a Chat lane whose bridge process may outlive
 * its attempt gets one file, in the lane's private temp directory so it moves
 * with the lane, that names the current attempt's token, turn and attempt.
 *
 * The directory is 0700 and the file 0600. Each write is a new 0600 temp file
 * renamed over the old one, so a reader sees one whole version or the next.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskContextFile } from "@shared/task-context-file.js";

export interface LaneTaskContext {
  token: string | null;
  turnId: string | null;
  attemptId: string | null;
}

export class LaneTaskContextFile {
  private constructor(
    private readonly directory: string,
    /** Where the daemon writes it. */
    readonly hostPath: string,
    /** Where the agent's process reads it (`MULTIREMI_TASK_CONTEXT_FILE`). */
    readonly visiblePath: string,
  ) {}

  /**
   * A new context file in `privateTmpDirectory` (the real path, not the macOS alias).
   *
   * On Linux the agent's literal `/tmp` is that directory, so it reads the
   * file under `/tmp`; the name is random so no host `/tmp` path can match it
   * (the private-tmp launcher binds env-named host `/tmp` paths in). Elsewhere
   * the agent reads the host path itself.
   */
  static create(privateTmpDirectory: string, platform: NodeJS.Platform = process.platform): LaneTaskContextFile {
    const name = `.remi-task-${randomBytes(8).toString("hex")}`;
    const directory = join(privateTmpDirectory, name);
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    const hostPath = join(directory, "context.json");
    return new LaneTaskContextFile(directory, hostPath, platform === "linux" ? join("/tmp", name, "context.json") : hostPath);
  }

  /** Name `context`'s attempt as the one running on the process; `token: null` when none does (parked). */
  write(context: LaneTaskContext): void {
    this.assertDirectory();
    const body: TaskContextFile = {
      token: context.token || null,
      turn_id: context.turnId || null,
      attempt_id: context.attemptId || null,
      written_at: new Date().toISOString(),
    };
    const temporary = join(this.directory, `.context-${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.hostPath);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  /** Remove the file (after a failed write), so readers use the env rather than an older attempt's version. */
  discard(): void {
    this.assertDirectory();
    rmSync(this.hostPath, { force: true });
  }

  /** The agent can write its own /tmp: touch only the real directory this made. */
  private assertDirectory(): void {
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Task context directory is not a real directory");
  }
}
