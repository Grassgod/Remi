// Cloud runtime node CRUD, extracted verbatim from MultiremiStore (delegated).
import { type SqlDatabase } from "@multiremi/store/db/sql-database.js";
import { createId, nowIso } from "@multiremi/ids.js";
import { parseJson, toJson } from "@multiremi/store/helpers.js";
import type {
  CreateCloudRuntimeNodeInput,
  MultiremiCloudRuntimeNode,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class CloudRuntimeNodesRepo {
  constructor(private db: SqlDatabase) {}

  listCloudRuntimeNodes(options: { limit?: number; offset?: number; ownerId?: string | null } = {}): MultiremiCloudRuntimeNode[] {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const rows = options.ownerId
      ? this.db.query("SELECT * FROM multiremi_cloud_runtime_nodes WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(options.ownerId, limit, offset) as Row[]
      : this.db.query("SELECT * FROM multiremi_cloud_runtime_nodes ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Row[];
    return rows.map(toCloudRuntimeNode);
  }

  createCloudRuntimeNode(input: CreateCloudRuntimeNodeInput, ownerId = "local"): MultiremiCloudRuntimeNode {
    const instanceType = String(input.instanceType ?? input.instance_type ?? "").trim();
    if (!instanceType) throw new Error("instance_type is required");
    const id = createId("crn");
    const now = nowIso();
    const name = String(input.name ?? "").trim() || `local-${instanceType}`;
    this.db.run(
      `INSERT INTO multiremi_cloud_runtime_nodes (
        id, owner_id, instance_id, region, instance_type, image_id, subnet_id,
        name, status, tags, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'launching', ?, ?, ?, ?)`,
      [
        id,
        ownerId,
        `local-${id}`,
        String(input.region ?? "local").trim() || "local",
        instanceType,
        String(input.imageId ?? input.image_id ?? "").trim(),
        String(input.subnetId ?? input.subnet_id ?? "").trim(),
        name,
        toJson(input.tags ?? {}),
        toJson(input.metadata ?? { local: true }),
        now,
        now,
      ],
    );
    return this.getCloudRuntimeNode(id)!;
  }

  getCloudRuntimeNode(id: string): MultiremiCloudRuntimeNode | null {
    const row = this.db.query("SELECT * FROM multiremi_cloud_runtime_nodes WHERE id = ?").get(id) as Row | null;
    return row ? toCloudRuntimeNode(row) : null;
  }

  deleteCloudRuntimeNode(id: string): boolean {
    const result = this.db.run("DELETE FROM multiremi_cloud_runtime_nodes WHERE id = ?", [id]);
    return result.changes > 0;
  }

  setCloudRuntimeNodeStatus(id: string, status: string): MultiremiCloudRuntimeNode | null {
    const current = this.getCloudRuntimeNode(id);
    if (!current) return null;
    this.db.run("UPDATE multiremi_cloud_runtime_nodes SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
    return this.getCloudRuntimeNode(id);
  }

  execCloudRuntimeNode(id: string, command: string): { node: MultiremiCloudRuntimeNode; exit_code: number; stdout: string; stderr: string } | null {
    const node = this.getCloudRuntimeNode(id);
    if (!node) return null;
    const output = command.trim() ? `local cloud runtime node ${id}: ${command.trim()}` : `local cloud runtime node ${id}`;
    return { node, exit_code: 0, stdout: output, stderr: "" };
  }
}

function toCloudRuntimeNode(row: Row): MultiremiCloudRuntimeNode {
  const createdAt = String(row.created_at);
  const updatedAt = String(row.updated_at);
  const ownerId = String(row.owner_id ?? "local");
  const instanceId = String(row.instance_id ?? "");
  const instanceType = String(row.instance_type ?? "");
  const imageId = String(row.image_id ?? "");
  const subnetId = String(row.subnet_id ?? "");
  return {
    id: String(row.id),
    ownerId,
    owner_id: ownerId,
    instanceId,
    instance_id: instanceId,
    region: String(row.region ?? "local"),
    instanceType,
    instance_type: instanceType,
    imageId,
    image_id: imageId,
    subnetId,
    subnet_id: subnetId,
    name: String(row.name ?? ""),
    status: String(row.status ?? "unknown"),
    tags: parseJson<Record<string, string>>(row.tags, {}),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
  };
}
