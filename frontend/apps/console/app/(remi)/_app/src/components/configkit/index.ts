/**
 * configkit — shared building blocks for config pages.
 *
 * Pages compose these (PageHeader + StatTile + EmptyState + SkeletonGrid)
 * so every Dashboard config page (Mcp / Prompts / Providers / Agents /
 * Skills / BotMenu / …) gets the same visual language and motion.
 */
export { PageHeader } from "./PageHeader";
export type { PageHeaderProps } from "./PageHeader";
export { StatTile } from "./StatTile";
export type { StatTileProps, StatAccent } from "./StatTile";
export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";
export { SkeletonCard, SkeletonGrid } from "./SkeletonCard";

/** Stagger animation delay helper — apply per index for cascading reveals. */
export function staggerStyle(index: number, baseMs = 0, stepMs = 60): React.CSSProperties {
  return { animation: `fade-in 0.35s ease-out ${baseMs + index * stepMs}ms both` };
}
