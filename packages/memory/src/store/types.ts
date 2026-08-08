/**
 * Shared shapes for the MemoryStore domain split.
 *
 * Moved verbatim out of `memory/store.ts`; the recall result types are
 * re-exported from there so the public surface is unchanged.
 */

export interface IndexEntry {
  type: string;
  name: string;
  tags: string[];
  summary: string;
  aliases: string[];
  importance: number;
  lastAccessed: string;
  accessCount: number;
}

export interface RecallLayerResult {
  name: string;
  ran: boolean;
  durationMs: number;
  candidateCount: number;
  exitedEarly?: boolean;
  reason?: string;
  matches: Array<{ source: string; name: string; snippet: string }>;
}

export interface RecallDebugResult {
  query: string;
  result: string;
  totalMs: number;
  layers: RecallLayerResult[];
}
