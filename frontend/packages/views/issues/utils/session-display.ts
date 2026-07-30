import type { IssueSession } from "@multiremi/core/types";
import type { useT } from "../../i18n";

type IssuesT = ReturnType<typeof useT<"issues">>["t"];

/**
 * The name a Session is shown under.
 *
 * The default Session's stored title is a server-side constant ("Main") that
 * no user ever typed, so every surface renders the localized label instead —
 * the rail row, the comment composer, the key-result "From …" line. Storage
 * and the API keep the raw title untouched; this is the single place that
 * decides what a human reads, so the four surfaces cannot drift apart.
 */
export function getSessionDisplayName(
  t: IssuesT,
  session: Pick<IssueSession, "title" | "is_default"> | null | undefined,
): string {
  if (!session) return "";
  if (session.is_default === true) return t(($) => $.detail.main_session);
  return session.title;
}
