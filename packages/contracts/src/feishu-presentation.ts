import type { FeishuPresentationCheckpoint } from "./types.js";

export function parseFeishuPresentation(value: unknown): FeishuPresentationCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as FeishuPresentationCheckpoint;
  if (p.version !== "native_cot_v1" || !Number.isSafeInteger(p.startedAt) || p.startedAt <= 0
    || !Number.isSafeInteger(p.throughSeq) || p.throughSeq < 0
    || !p.interactions || typeof p.interactions !== "object" || Array.isArray(p.interactions)) return null;
  const id = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 512;
  if (p.interactionOpenId !== undefined && !/^ou_[A-Za-z0-9_-]{1,128}$/.test(p.interactionOpenId)) return null;
  if (p.resultMessageId !== undefined && !id(p.resultMessageId)) return null;
  if (Object.keys(p.interactions).length > 256 || Object.entries(p.interactions).some(([key, entry]) =>
    !id(key) || ["__proto__", "constructor", "prototype"].includes(key) || !entry || !id(entry.messageId)
    || (entry.receiptStatus !== undefined && !["responded", "timeout", "cancelled"].includes(entry.receiptStatus))
    || (entry.waitingStarted !== undefined && typeof entry.waitingStarted !== "boolean")
    || (entry.waitingFinished !== undefined && typeof entry.waitingFinished !== "boolean"))) return null;
  if (p.cot) {
    if (typeof p.cot !== "object" || Array.isArray(p.cot)) return null;
    if (!["creating", "active", "finished", "disabled"].includes(p.cot.status)) return null;
    if (p.cot.presentation !== undefined && p.cot.presentation !== "semantic_v1") return null;
    if (["active", "finished"].includes(p.cot.status) && (!id(p.cot.cotId) || !id(p.cot.messageId))) return null;
    if (p.cot.cotId !== undefined && !id(p.cot.cotId)) return null;
    if (p.cot.messageId !== undefined && !id(p.cot.messageId)) return null;
    if (p.cot.error !== undefined && (typeof p.cot.error !== "string" || p.cot.error.length > 500)) return null;
    if (p.cot.lastTimestamp !== undefined && !Number.isSafeInteger(p.cot.lastTimestamp)) return null;
    if (p.cot.writePending !== undefined && typeof p.cot.writePending !== "boolean") return null;
    if (p.cot.runStarted !== undefined && typeof p.cot.runStarted !== "boolean") return null;
  }
  return p;
}

/** A checkpoint may advance delivery, but cannot forget acknowledged messages. */
export function advancesFeishuPresentation(previous: FeishuPresentationCheckpoint, next: FeishuPresentationCheckpoint): boolean {
  if (next.startedAt !== previous.startedAt || next.throughSeq < previous.throughSeq) return false;
  if (previous.interactionOpenId && next.interactionOpenId !== previous.interactionOpenId) return false;
  if (previous.resultMessageId && next.resultMessageId !== previous.resultMessageId) return false;
  if (previous.cot) {
    if (!next.cot) return false;
    if (previous.cot.cotId && next.cot.cotId !== previous.cot.cotId) return false;
    if (previous.cot.messageId && next.cot.messageId !== previous.cot.messageId) return false;
    if (["finished", "disabled"].includes(previous.cot.status) && next.cot.status !== previous.cot.status) return false;
    if (previous.cot.runStarted && !next.cot.runStarted) return false;
    if (previous.cot.presentation && next.cot.presentation !== previous.cot.presentation) return false;
  }
  return Object.entries(previous.interactions).every(([id, saved]) =>
    next.interactions[id]?.messageId === saved.messageId
    && (!saved.receiptStatus || next.interactions[id]?.receiptStatus === saved.receiptStatus)
    && (!saved.waitingStarted || next.interactions[id]?.waitingStarted === true)
    && (!saved.waitingFinished || next.interactions[id]?.waitingFinished === true));
}
