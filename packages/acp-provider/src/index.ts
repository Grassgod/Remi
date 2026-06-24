// re-export shim — package impl moved to src/acp/ in D2 (refactor/dir-redesign).
// @remi/acp-provider stays import-compatible until call sites migrate (铁律#9).
export * from "../../../src/acp/index.js";
