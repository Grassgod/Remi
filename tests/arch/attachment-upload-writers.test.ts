import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const helper = "packages/server/src/api/helpers/uploads.ts";
const storageReference = /uploadRoot|uploadAbsolutePath|uploadRelativePath|uploadedAttachmentPath|MULTIREMI_UPLOAD_DIR|["']uploads["']/;
const writeOperation = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|copyFile(?:Sync)?|rename(?:Sync)?|open(?:Sync)?)\b|Bun\s*\.\s*write\s*\(/;

function bypassesHelper(path: string, source: string) {
  return path !== helper && storageReference.test(source) && writeOperation.test(source);
}

it("all attachment-directory writers go through the exclusive upload helper", () => {
  const offenders: string[] = [];
  for (const path of new Bun.Glob("packages/server/src/**/*.ts").scanSync({ cwd: root })) {
    if (bypassesHelper(path, readFileSync(join(root, path), "utf8"))) offenders.push(path);
  }
  expect(offenders).toEqual([]);
  const source = readFileSync(join(root, helper), "utf8");
  expect(source).toContain('open(path, "wx")');
  for (const path of ["attachments", "daemon"]) {
    expect(readFileSync(join(root, `packages/server/src/api/routers/${path}.ts`), "utf8"))
      .toContain("persistUploadedAttachments(");
  }
});

it("the source guard rejects bypasses for both direct and reconstructed upload paths", () => {
  for (const source of [
    "await writeFile(uploadedAttachmentPath(attachment), bytes)",
    'import { writeFile as save } from "node:fs/promises"; await save(uploadAbsolutePath(relative), bytes)',
    "await Bun.write(join(process.env.MULTIREMI_UPLOAD_DIR, filename), bytes)",
    'await writeFile(join(homedir(), ".remi", "multiremi", "uploads", filename), bytes)',
  ]) expect(bypassesHelper("packages/server/src/api/routers/new-upload.ts", source)).toBe(true);
});
