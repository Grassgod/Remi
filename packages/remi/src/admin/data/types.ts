/**
 * RemiData — shared public data shapes.
 *
 * Moved verbatim out of `admin/remi-data.ts`; re-exported from there so the
 * public surface is unchanged.
 */

import type { TokenStatus as AuthTokenStatus } from "@auth/types.js";

export interface EntitySummary {
  type: string;
  name: string;
  tags: string[];
  summary: string;
  aliases: string[];
  related: string[];
  path: string;       // relative to entities/
  updatedAt: string;
}

export interface EntityDetail extends EntitySummary {
  content: string;     // full markdown including frontmatter
  body: string;        // markdown body only
  createdAt: string;
  metadata: Record<string, unknown>;  // complete YAML frontmatter
}

/** The admin API's token row: AuthAdapter.status() plus a human-readable countdown. */
export interface TokenStatus extends AuthTokenStatus {
  expiresIn: string;   // human-readable
}

export interface DailyLogEntry {
  date: string;
  size: number;
}

export interface SearchResult {
  source: string;      // "entity" | "daily" | "global"
  name: string;
  snippet: string;
  path: string;
}
