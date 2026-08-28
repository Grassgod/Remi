export const MAX_WIKI_PATH_LENGTH = 512;
export const MAX_WIKI_DIRECTORY_DEPTH = 5;

/** Normalize a workspace-relative Markdown path used by Project and Repository Wiki. */
export function normalizeWikiPath(value: unknown): string {
  const text = String(value ?? "").trim();
  if (
    !text
    || text.length > MAX_WIKI_PATH_LENGTH
    || text.startsWith("/")
    || text.endsWith("/")
    || text.includes("\\")
    || text.includes("\0")
  ) {
    throw new Error("invalid wiki path");
  }
  const parts = text.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..")
    || parts.length - 1 > MAX_WIKI_DIRECTORY_DEPTH
  ) {
    throw new Error("invalid wiki path");
  }
  const normalized = parts.join("/");
  const path = normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
  if (path.length > MAX_WIKI_PATH_LENGTH) throw new Error("invalid wiki path");
  return path;
}
