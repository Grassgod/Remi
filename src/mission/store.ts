/**
 * MissionStore — SQLite CRUD for missions and skill_feedbacks.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.js";
import { createThread } from "../connectors/feishu/thread.js";
import { createLogger } from "../logger.js";
import type {
  Mission,
  MissionCreate,
  MissionStatus,
  PipelineStep,
  SkillFeedback,
  FeedbackType,
} from "./model.js";

const log = createLogger("mission-store");

function nanoid(len = 12): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) id += chars[bytes[i] % chars.length];
  return id;
}

export class MissionStore {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  // ── Create ──

  create(input: MissionCreate): Mission {
    const id = `msn_${nanoid()}`;
    const now = new Date().toISOString();
    const outputDir = `${process.env.HOME ?? "~"}/.remi/missions/${id}`;

    this.db.run(
      `INSERT INTO missions (id, title, description, status, project_id, chat_id, thread_id,
        current_step, output_dir, created_by, created_by_name, created_at, updated_at)
       VALUES (?, ?, ?, 'inbox', ?, ?, ?, 'intake', ?, ?, ?, ?, ?)`,
      [
        id,
        input.title,
        input.description ?? null,
        input.projectId,
        input.chatId,
        input.threadId ?? null,
        outputDir,
        input.createdBy ?? null,
        input.createdByName ?? null,
        now,
        now,
      ],
    );

    return this.getById(id)!;
  }

  /**
   * Create a mission with automatic thread creation for topic-mode groups.
   */
  async createWithThread(input: MissionCreate): Promise<Mission> {
    let threadId = input.threadId;

    if (!threadId && input.chatId) {
      try {
        const result = await createThread(input.chatId, `Mission: ${input.title}`);
        // Store the root message ID (om_xxx) as threadId — this matches msg.rootId
        // in Feishu message events, enabling _resolveMissionForThread to find the mission.
        threadId = result.messageId;
        log.info(`Auto-created thread ${result.threadId} (root=${result.messageId}) for mission "${input.title}"`);
      } catch (err) {
        log.warn(`Failed to auto-create thread: ${(err as Error).message}`);
      }
    }

    return this.create({ ...input, threadId });
  }

  // ── Read ──

  getById(id: string): Mission | null {
    const row = this.db.query("SELECT * FROM missions WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? this._toMission(row) : null;
  }

  listByProject(projectId: string): Mission[] {
    const rows = this.db.query(
      "SELECT * FROM missions WHERE project_id = ? ORDER BY updated_at DESC"
    ).all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this._toMission(r));
  }

  listByStatus(status: MissionStatus): Mission[] {
    const rows = this.db.query(
      "SELECT * FROM missions WHERE status = ? ORDER BY updated_at DESC"
    ).all(status) as Record<string, unknown>[];
    return rows.map((r) => this._toMission(r));
  }

  listByMRStatus(mrStatus: string): Mission[] {
    const rows = this.db.query(
      "SELECT * FROM missions WHERE mr_status = ? ORDER BY updated_at DESC"
    ).all(mrStatus) as Record<string, unknown>[];
    return rows.map((r) => this._toMission(r));
  }

  // ── Update ──

  updateStatus(id: string, status: MissionStatus): void {
    const now = new Date().toISOString();
    const completedAt = status === "done" ? now : null;
    this.db.run(
      `UPDATE missions SET status = ?, updated_at = ?,
       completed_at = COALESCE(?, completed_at) WHERE id = ?`,
      [status, now, completedAt, id],
    );
  }

  updateStep(id: string, step: PipelineStep): void {
    this.db.run(
      "UPDATE missions SET current_step = ?, updated_at = ? WHERE id = ?",
      [step, new Date().toISOString(), id],
    );
  }

  updateSessions(id: string, sessions: Record<string, string>): void {
    this.db.run(
      "UPDATE missions SET sessions = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(sessions), new Date().toISOString(), id],
    );
  }

  updateMR(id: string, mrUrl: string, mrStatus: string): void {
    this.db.run(
      "UPDATE missions SET mr_url = ?, mr_status = ?, updated_at = ? WHERE id = ?",
      [mrUrl, mrStatus, new Date().toISOString(), id],
    );
  }

  updateContract(id: string, contract: string): void {
    this.db.run(
      "UPDATE missions SET contract = ?, updated_at = ? WHERE id = ?",
      [contract, new Date().toISOString(), id],
    );
  }

  update(id: string, fields: Partial<Pick<Mission, "title" | "description" | "status" | "currentStep">>): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (fields.title !== undefined) { sets.push("title = ?"); values.push(fields.title); }
    if (fields.description !== undefined) { sets.push("description = ?"); values.push(fields.description); }
    if (fields.status !== undefined) { sets.push("status = ?"); values.push(fields.status); }
    if (fields.currentStep !== undefined) { sets.push("current_step = ?"); values.push(fields.currentStep); }

    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    this.db.run(`UPDATE missions SET ${sets.join(", ")} WHERE id = ?`, values);
  }

  markReleased(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE missions SET released_at = ?, updated_at = ? WHERE id IN (${placeholders})`,
      [now, now, ...ids],
    );
  }

  // ── Delete ──

  delete(id: string): void {
    this.db.run("DELETE FROM missions WHERE id = ?", [id]);
  }

  // ── Skill Feedbacks ──

  recordFeedback(missionId: string, step: PipelineStep, skillName: string, feedbackType: FeedbackType, detail?: string): void {
    const id = `fb_${nanoid()}`;
    this.db.run(
      `INSERT INTO skill_feedbacks (id, mission_id, step, skill_name, feedback_type, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, missionId, step, skillName, feedbackType, detail ?? null],
    );
  }

  getRecentFeedbacks(withinMs: number): SkillFeedback[] {
    const since = new Date(Date.now() - withinMs).toISOString();
    const rows = this.db.query(
      "SELECT * FROM skill_feedbacks WHERE created_at > ? ORDER BY created_at DESC"
    ).all(since) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      missionId: r.mission_id as string,
      step: r.step as PipelineStep,
      skillName: r.skill_name as string,
      feedbackType: r.feedback_type as FeedbackType,
      detail: (r.detail as string) ?? null,
      createdAt: r.created_at as string,
    }));
  }

  // ── Stats ──

  getProjectStats(projectId: string): {
    total: number;
    byStatus: Record<string, number>;
    totalCost: number;
    totalTokens: number;
  } {
    const missions = this.listByProject(projectId);
    const byStatus: Record<string, number> = {};
    let totalCost = 0;
    let totalTokens = 0;

    for (const m of missions) {
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      totalCost += m.totalCost;
      totalTokens += m.totalTokens;
    }

    return { total: missions.length, byStatus, totalCost, totalTokens };
  }

  // ── Internal ──

  private _toMission(row: Record<string, unknown>): Mission {
    return {
      id: row.id as string,
      title: row.title as string,
      description: (row.description as string) ?? null,
      status: row.status as MissionStatus,
      projectId: row.project_id as string,
      chatId: row.chat_id as string,
      threadId: (row.thread_id as string) ?? null,
      currentStep: (row.current_step as PipelineStep) ?? "intake",
      contract: row.contract ? JSON.parse(row.contract as string) : null,
      mrUrl: (row.mr_url as string) ?? null,
      mrStatus: (row.mr_status as string) ?? null,
      outputDir: (row.output_dir as string) ?? null,
      sessions: row.sessions ? JSON.parse(row.sessions as string) : {},
      createdBy: (row.created_by as string) ?? null,
      createdByName: (row.created_by_name as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      completedAt: (row.completed_at as string) ?? null,
      releasedAt: (row.released_at as string) ?? null,
      totalTokens: (row.total_tokens as number) ?? 0,
      totalCost: (row.total_cost as number) ?? 0,
      totalDuration: (row.total_duration as number) ?? 0,
    };
  }
}
