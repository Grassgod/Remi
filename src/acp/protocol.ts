// re-export shim — ACP protocol types moved to src/shared/acp-protocol.ts in Phase 1
// (L0: connectors/L1 must import ACP contract types from shared, not from acp/L1).
export * from "@shared/contracts/acp-protocol.js";
