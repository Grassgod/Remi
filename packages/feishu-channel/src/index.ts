// re-export shim — package impl moved to src/connectors/feishu/ in D5 (refactor/dir-redesign).
// @remi/feishu-channel stays import-compatible until call sites migrate (铁律#9).
export * from "../../../src/connectors/feishu/sdk.js";
