import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";

/** Build-context manifests only. Unsupported future workspace patterns fail closed. */
export function workspaceManifestPaths(root: string): string[] {
  const base = realpathSync(root);
  const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  if (!Array.isArray(pkg.workspaces) || !pkg.workspaces.every((pattern: unknown) => typeof pattern === "string")) throw new Error("Expected workspace pattern array");
  const manifests = new Set<string>(["package.json"]);
  for (const pattern of pkg.workspaces as string[]) {
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*(?:\/\*)?$/.test(pattern)) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const parent = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
    const dirs = pattern.endsWith("/*")
      ? readdirSync(join(base, parent), { withFileTypes: true }).filter(item => { if (item.isSymbolicLink()) throw new Error(`Symlink workspace requires explicit Docker inputs: ${parent}/${item.name}`); return item.isDirectory(); }).map(item => join(parent, item.name))
      : [parent];
    for (const dir of dirs) {
      const path = join(dir, "package.json");
      if (!existsSync(join(base, path))) { if (!pattern.endsWith("/*")) throw new Error(`Missing workspace manifest: ${path}`); continue; }
      const actual = realpathSync(join(base, path));
      if (relative(base, actual).startsWith("..")) throw new Error(`Workspace manifest escapes context: ${path}`);
      manifests.add(path.replaceAll("\\", "/"));
    }
  }
  const paths = [...manifests].sort();
  for (const path of paths) {
    const manifest = JSON.parse(readFileSync(join(base, path), "utf8"));
    if (path !== "package.json" && manifest.bin) throw new Error(`Workspace bin requires source before install: ${path}`);
    if (manifest.patchedDependencies && Object.keys(manifest.patchedDependencies).length) throw new Error(`Patched dependencies require explicit Docker inputs: ${path}`);
    const inspect = (value: unknown): void => {
      if (typeof value === "string" && /^(?:file:|link:|portal:|patch:|\.\.?\/)/.test(value)) throw new Error(`Local dependency requires explicit Docker inputs: ${path}`);
      if (value && typeof value === "object") for (const child of Object.values(value)) inspect(child);
    };
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"]) inspect(manifest[key]);
  }
  return paths;
}

export function copyWorkspaceManifests(root: string, out: string): string[] {
  if (existsSync(out) && readdirSync(out).length) throw new Error("Manifest output directory must be empty");
  const paths = [...workspaceManifestPaths(root), "bun.lock", "bunfig.toml"];
  for (const path of paths) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    copyFileSync(join(root, path), join(out, path));
  }
  return paths;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const index = args.indexOf(`--${name}`); if (index < 0 || !args[index + 1]) throw new Error(`Missing --${name}`); return resolve(args[index + 1]); };
  copyWorkspaceManifests(option("root"), option("out"));
}
