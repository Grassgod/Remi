/**
 * The Chat reading column (Codex): a 768px box with 16px side padding, so
 * message text and bubbles, the rows stacked above the composer (question
 * lines, banners, the queue, notices) and the composer's border all sit on
 * one 736px column and share its left and right edges. Narrower than 768px
 * (the floating window, mobile, a page the subagent panel squeezes) it fills
 * the width and keeps the 16px padding.
 *
 * Each of those rows puts it on its own outermost element and fills the
 * content box, so its visible edge is the column's edge.
 */
export const CHAT_COLUMN_CLASS = "mx-auto w-full max-w-[768px] px-4";
