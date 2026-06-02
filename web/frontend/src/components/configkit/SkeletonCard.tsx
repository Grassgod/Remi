/**
 * Skeleton placeholders for list/grid loading states.
 * Use <SkeletonGrid count={3} /> for a 3-card placeholder.
 */
export function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div className={`relative h-28 animate-pulse overflow-hidden rounded-xl border border-border/40 bg-muted/30 ${className}`}>
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-muted-foreground/10 via-muted-foreground/30 to-muted-foreground/10" />
    </div>
  );
}

export function SkeletonGrid({ count = 3, cols = "sm:grid-cols-2 lg:grid-cols-3" }: { count?: number; cols?: string }) {
  return (
    <div className={`grid gap-3 ${cols}`}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
