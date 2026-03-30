/**
 * Module-level registry for the active FeishuConnector instance.
 * Allows other modules (e.g. project init) to interact with the live connector
 * without circular dependency on core.ts.
 */

import type { FeishuConnector } from "./index.js";

let _instance: FeishuConnector | null = null;

export function setActiveFeishuConnector(connector: FeishuConnector): void {
  _instance = connector;
}

export function getActiveFeishuConnector(): FeishuConnector | null {
  return _instance;
}
