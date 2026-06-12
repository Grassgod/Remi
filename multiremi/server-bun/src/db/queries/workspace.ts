/** Workspace queries — port of the Go workspace handler's list/create logic. */

import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { workspace, member, type Workspace } from "../schema.js";

/** Resolve a workspace by its slug (the X-Workspace-Slug header path). */
export async function getWorkspaceBySlug(db: Db, slug: string): Promise<Workspace | null> {
  const [w] = await db.select().from(workspace).where(eq(workspace.slug, slug));
  return w ?? null;
}

export async function listWorkspacesForUser(db: Db, userId: string): Promise<Workspace[]> {
  const rows = await db
    .select({ ws: workspace })
    .from(workspace)
    .innerJoin(member, eq(member.workspaceId, workspace.id))
    .where(eq(member.userId, userId));
  return rows.map((r) => r.ws);
}

/**
 * Derive a short issue identifier prefix (e.g. "MUL") from the workspace name,
 * so issues read as "MUL-123". Mirrors Go's generateIssuePrefix: initials of
 * the words, else the first letters of the name, uppercased, 2–4 chars.
 */
export function generateIssuePrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  let p = words.length > 1
    ? words.map((w) => w[0]!).join("")
    : (words[0] ?? "WS");
  p = p.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 4);
  return p.length >= 2 ? p : (p + "WS").slice(0, 3);
}

export async function createWorkspace(
  db: Db,
  input: { name: string; slug: string; description?: string | null },
  ownerUserId: string,
): Promise<Workspace> {
  // workspace + owner membership in one transaction (mirrors the Go handler).
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspace)
      .values({
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        issuePrefix: generateIssuePrefix(input.name),
      })
      .returning();
    await tx.insert(member).values({ workspaceId: ws!.id, userId: ownerUserId, role: "owner" });
    return ws!;
  });
}
