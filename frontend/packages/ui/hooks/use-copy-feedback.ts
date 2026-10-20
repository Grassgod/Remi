import { useCallback, useEffect, useState } from "react";

/**
 * The "Copied" state of a copy button. `markCopied()` shows it and it hides
 * itself `durationMs` later; copying again restarts the countdown. The timer
 * lives in an effect, so unmounting clears it and the reset never lands on a
 * component that is gone (or after a test's DOM has been torn down).
 */
export function useCopyFeedback(
  durationMs = 2000,
): readonly [copied: boolean, markCopied: () => void, reset: () => void] {
  // Copies made while the feedback shows; 0 hides it. Each copy is a new
  // value, so the effect replaces the running timer.
  const [copies, setCopies] = useState(0);
  useEffect(() => {
    if (copies === 0) return;
    const timer = setTimeout(() => setCopies(0), durationMs);
    return () => clearTimeout(timer);
  }, [copies, durationMs]);
  const markCopied = useCallback(() => setCopies((n) => n + 1), []);
  const reset = useCallback(() => setCopies(0), []);
  return [copies > 0, markCopied, reset] as const;
}
