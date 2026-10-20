/**
 * The Chat reading column (Codex): a 768px box with 16px side padding, so
 * message text and bubbles, the rows stacked above the composer (question
 * lines, banners, the queue, notices) and the composer's border all sit on
 * one column (736px of text) and share its left and right edges. Narrower
 * than 768px (the floating window, mobile, a page the subagent panel
 * squeezes) it fills the width and keeps the 16px padding.
 *
 * On a wide conversation pane the column grows with the pane, like Codex's
 * expanded thread width: from a 1200px pane it is 64% of the pane, which is
 * exactly 768px there and reaches the 960px cap (928px of text) at 1500px.
 * 1200px is just above the widest pane a laptop gets in the default layout
 * (the sidebar and the 300px chat list take 564px, so a 1728px-wide 16-inch
 * MacBook Pro leaves 1164px): the column grows only once panels are hidden
 * on a large laptop or on an external display. At 1200px the 768px column
 * already leaves 216px (18%) on each side, and up to 1500px it keeps those
 * proportions.
 *
 * The width follows the pane ({@link CHAT_PANE_CLASS}), not the viewport,
 * because the app sidebar, the chat list and the subagent split all change
 * it. The query names that container, so where there is none (the floating
 * window) the column stays at 768px. Its `cqi` resolves against the nearest
 * size container: the pane for the composer and the rows around it, the
 * message list's own `chat-log` container (as wide as the pane) for the
 * messages, so both sides get the same width.
 *
 * Each of those rows puts it on its own outermost element and fills the
 * content box, so its visible edge is the column's edge.
 */
export const CHAT_COLUMN_CLASS =
  "mx-auto w-full max-w-[768px] px-4 @min-[1200px]/chat-pane:max-w-[clamp(768px,64cqi,960px)]";

/**
 * The conversation pane of the Chat page: the size container the column's
 * width follows. It wraps the message list and the composer together.
 */
export const CHAT_PANE_CLASS = "@container/chat-pane";
