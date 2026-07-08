/**
 * ProjectStore — SQLite CRUD for the projects table.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "@shared/db/index.js";
import type {
  Project,
  ProjectInitInput,
  ProjectInitStatus,
  InitStep,
  InitStepName,
  InitStepStatus,
} from "./model.js";
import { DEFAULT_INIT_STEPS } from "./model.js";

export class ProjectStore {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  // ── Create ──

  create(input: ProjectInitInput): Project {
    const now = new Date().toISOString();
    const steps = DEFAULT_INIT_STEPS.map((s) => ({ ...s }));

    this.db.run(
      `INSERT INTO projects (id, name, repo_url, cwd, init_status, init_steps, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        input.alias,
        input.name,
        input.repoUrl ?? null,
        input.dirMode === "existing" ? (input.existingPath ?? null) : null,
        JSON.stringify(steps),
        now,
        now,
      ],
    );

    return this.getById(input.alias)!;
  }

  // ── Read ──

  getById(id: string): Project | null {
    const row = this.db
      .query("SELECT * FROM projects WHERE id = ? AND (deleted = 0 OR deleted IS NULL)")
      .get(id) as Record<string, unknown> | null;
    return row ? this._toProject(row) : null;
  }

  /** Get by id including soft-deleted (for chatId reuse). */
  getByIdIncludeDeleted(id: string): Project | null {
    const row = this.db
      .query("SELECT * FROM projects WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? this._toProject(row) : null;
  }

  list(): Project[] {
    const rows = this.db
      .query("SELECT * FROM projects WHERE deleted = 0 OR deleted IS NULL ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this._toProject(r));
  }

  // ── Update ──

  updateInitStatus(id: string, status: ProjectInitStatus): void {
    this.db.run(
      "UPDATE projects SET init_status = ?, updated_at = datetime('now') WHERE id = ?",
      [status, id],
    );
  }

  updateInitStep(
    id: string,
    stepName: InitStepName,
    status: InitStepStatus,
    result?: string,
    error?: string,
  ): void {
    const project = this.getById(id);
    if (!project) return;

    const steps = project.initSteps.map((s) => {
      if (s.name !== stepName) return s;
      const updated: InitStep = { ...s, status };
      if (status === "running") updated.startedAt = new Date().toISOString();
      if (status === "done") {
        updated.completedAt = new Date().toISOString();
        if (result) updated.result = result;
      }
      if (status === "error" && error) updated.error = error;
      return updated;
    });

    this.db.run(
      "UPDATE projects SET init_steps = ?, updated_at = datetime('now') WHERE id = ?",
      [JSON.stringify(steps), id],
    );
  }

  updateField(id: string, field: "chat_id" | "cwd" | "repo_url", value: string): void {
    this.db.run(
      `UPDATE projects SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`,
      [value, id],
    );
  }

  updatePipelineConfig(id: string, config: unknown): void {
    this.db.run(
      "UPDATE projects SET pipeline_config = ?, updated_at = datetime('now') WHERE id = ?",
      [JSON.stringify(config), id],
    );
  }

  // ── Delete (soft) ──

  delete(id: string): boolean {
    const result = this.db.run(
      "UPDATE projects SET deleted = 1, updated_at = datetime('now') WHERE id = ?",
      [id],
    );
    return result.changes > 0;
  }

  /** Restore a soft-deleted project for re-init. */
  restore(id: string): void {
    this.db.run(
      "UPDATE projects SET deleted = 0, init_status = 'pending', updated_at = datetime('now') WHERE id = ?",
      [id],
    );
  }

  /** Hard-delete (for cleanup before re-creating). */
  hardDelete(id: string): void {
    this.db.run("DELETE FROM projects WHERE id = ?", [id]);
  }


  // ── Internal ──

  private _toProject(row: Record<string, unknown>): Project {
    return {
      id: row.id as string,
      name: row.name as string,
      chatId: (row.chat_id as string) ?? null,
      repoUrl: (row.repo_url as string) ?? null,
      cwd: (row.cwd as string) ?? null,
      pipelineConfig: row.pipeline_config
        ? JSON.parse(row.pipeline_config as string)
        : null,
      initStatus: (row.init_status as ProjectInitStatus) ?? "pending",
      initSteps: row.init_steps
        ? JSON.parse(row.init_steps as string)
        : [],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
