/**
 * Flat session log (MUL-403 C8).
 *
 * `session-log-list.tsx` is the list C9 (Issue detail) and C10 (Chat) mount;
 * `entry-html.tsx` renders one pre-rendered row; `use-row-heights.ts` owns the
 * height cache; `enhance.ts` is the DOM-level enhancement the two of them share.
 * The replica port they read lives in `@multiremi/core/replica`.
 */
export {
  SessionLogList,
  SESSION_LOG_DOM_LIMIT,
  NEW_MESSAGE_DISPLAY_CAP,
  type SessionLogListProps,
  type SessionLogListRenderArgs,
} from "./session-log-list";
export { EntryHtml, type EntryHtmlProps } from "./entry-html";
export {
  enhanceEntryHtml,
  parseFences,
  CODE_BLOCK_ATTR,
  COPIED_FEEDBACK_MS,
  COPY_BUTTON_ATTR,
  PREVIEW_SLOT_ATTR,
  type EnhancedEntryHtml,
  type EnhanceEntryHtmlOptions,
  type EntryPreviewKind,
  type EntryPreviewSlot,
} from "./enhance";
export {
  reservedRowHeight,
  rowIntersectsViewport,
  useRowHeights,
  type MeasurableRow,
  type UseRowHeightsOptions,
} from "./use-row-heights";
