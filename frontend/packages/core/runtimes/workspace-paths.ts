// Runtime paths belong to the remote machine, not the browser's operating system.
function parse(path: string) {
  const value = path.trim().replace(/\\/g, "/");
  const prefix = value.match(/^[a-z]:\//i)?.[0]
    ?? value.match(/^\/\/[^/]+\/[^/]+\/?/)?.[0]
    ?? (value.startsWith("/") ? "/" : null);
  if (!prefix) return null;
  const parts: string[] = [];
  for (const part of value.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return { prefix: prefix.replace(/\/$/, "") + "/", parts, windows: /^[a-z]:/i.test(prefix) || prefix.startsWith("//"), backslash: path.includes("\\") };
}

function format(path: NonNullable<ReturnType<typeof parse>>) {
  const value = path.prefix + path.parts.join("/");
  return path.backslash ? value.replace(/\//g, "\\") : value;
}

export function runtimeDirectoryParent(path: string): string | null {
  const parsed = parse(path);
  if (!parsed?.parts.length) return null;
  return format({ ...parsed, parts: parsed.parts.slice(0, -1) });
}

export function runtimeDirectoryName(path: string): string {
  return parse(path)?.parts.at(-1) ?? "";
}

export function relativeRuntimeDirectory(root: string, directory: string): string | null {
  const base = parse(root);
  const target = parse(directory);
  if (!base || !target) return null;
  const comparable = (part: string) => base.windows ? part.toLowerCase() : part;
  if (comparable(base.prefix) !== comparable(target.prefix)
    || base.parts.some((part, index) => comparable(part) !== comparable(target.parts[index] ?? ""))) return null;
  return target.parts.slice(base.parts.length).join("/") || ".";
}

export function runtimeWorkspaceDirectory(root: string, cwd = "."): string | null {
  if (/^(?:[a-z]:|[\\/])/i.test(cwd)) return null;
  const parsed = parse(`${root.replace(/[\\/]$/, "")}/${cwd || "."}`);
  if (!parsed) return null;
  const result = format({ ...parsed, backslash: root.includes("\\") });
  return relativeRuntimeDirectory(root, result) === null ? null : result;
}
