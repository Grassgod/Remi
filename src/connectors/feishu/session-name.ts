// re-export shim — session-name util moved to src/shared/session-name.ts in D4
// (L0 purity: shared/db/sessions.ts must not import upward into L1 feishu).
export * from "@shared/session-name.js";
