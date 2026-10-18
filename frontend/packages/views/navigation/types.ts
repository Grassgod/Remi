export interface NavigationAdapter {
  push(path: string): void;
  replace(path: string): void;
  /**
   * Optional: replace the current URL (no new history entry) and update
   * `pathname` / `searchParams` without asking the server to render the route
   * again. For pages whose client state already shows the new URL; a reload or
   * a link to that URL still renders it on the server. Callers fall back to
   * `replace` when a platform leaves it undefined.
   */
  replaceUrl?: (path: string) => void;
  back(): void;
  pathname: string;
  searchParams: URLSearchParams;
  /**
   * Desktop only: open a path in a new tab. Optional `title` overrides the
   * default tab label. `opts.activate` controls focus:
   *   - `false` / omitted → background tab (browser cmd+click semantics; what
   *     modifier-click on links and mentions should use).
   *   - `true` → foreground tab (explicit "Open in new tab" toolbar buttons,
   *     where the user is asking to move into the new context).
   * Cross-workspace paths always switch workspace, regardless of `activate`.
   */
  openInNewTab?: (
    path: string,
    title?: string,
    opts?: { activate?: boolean },
  ) => void;
  /** Return a shareable URL for a path. Web: origin + path. Desktop: public web URL of the connected environment. */
  getShareableUrl: (path: string) => string;
  /**
   * Optional: warm up route assets / RSC payload for a path. Web wires this
   * to `router.prefetch`; desktop leaves it undefined because react-router
   * already loads the whole SPA. Callers must invoke via `prefetch?.(href)`.
   */
  prefetch?: (path: string) => void;
}
