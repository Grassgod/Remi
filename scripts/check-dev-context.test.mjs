import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateDevContext } from './check-dev-context.mjs';

const metadata = '---\ntitle: Development\nstatus: active\nsummary: Current development context\n---\n';

async function fixture(t, content = metadata) {
  const root = await mkdtemp(join(tmpdir(), 'remi-dev-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/dev'), { recursive: true });
  await mkdir(join(root, 'frontend'));
  for (const path of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'TESTING.md', 'frontend/AGENTS.md', 'frontend/CLAUDE.md', 'frontend/README.md', 'frontend/README.zh-CN.md', 'frontend/CONTRIBUTING.md']) {
    await writeFile(join(root, path), '# Entry\n');
  }
  await writeFile(join(root, 'docs/dev/README.md'), content);
  return root;
}

test('accepts valid metadata, entry links, titles, and Chinese paths with spaces', async (t) => {
  const root = await fixture(t, metadata + '[Details](<中文 说明.md> "Read details")\n[Encoded](%E4%B8%AD%E6%96%87%20%E8%AF%B4%E6%98%8E.md#section)\n[Root](../../AGENTS.md)\n[Nested [label]](中文 说明.md)\n');
  await writeFile(join(root, 'docs/dev/中文 说明.md'), metadata);
  await writeFile(join(root, 'AGENTS.md'), '[Context](docs/dev/README.md "Development")\n');
  assert.deepEqual(await validateDevContext(root), []);
});

test('rejects missing or empty metadata and unknown status', async (t) => {
  const root = await fixture(t, '# No metadata\n');
  assert.match((await validateDevContext(root)).join('\n'), /missing YAML frontmatter/);
  await writeFile(join(root, 'docs/dev/README.md'), '---\ntitle: ""\nstatus: deprecated\nsummary: # empty\n---\n');
  const errors = await validateDevContext(root);
  assert.equal(errors.length, 3);
  assert.match(errors.join('\n'), /title must be non-empty/);
  assert.match(errors.join('\n'), /status must be active in development context/);
  assert.match(errors.join('\n'), /summary must be non-empty/);
});

test('rejects broken inline and reference links with source line numbers', async (t) => {
  const root = await fixture(t, metadata + '[Missing](missing.md)\n[reference]: another.md "Title"\n');
  assert.deepEqual(await validateDevContext(root), [
    'docs/dev/README.md:6: link target does not exist: missing.md',
    'docs/dev/README.md:7: link target does not exist: another.md',
  ]);
});

test('rejects plain and encoded paths escaping the repository', async (t) => {
  const root = await fixture(t, metadata + '[Outside](../../../outside.md)\n[Encoded](%2e%2e/%2e%2e/%2e%2e/outside.md)\n[Absolute](/outside.md)\n[Windows](C:/outside.md)\n');
  const errors = await validateDevContext(root);
  assert.equal(errors.length, 4);
  assert.ok(errors.every((error) => error.includes('link escapes repository')));
});

test('ignores fenced, indented, and inline code examples plus external and anchor links', async (t) => {
  const content = metadata + [
    '```md', '[Example](missing-one.md)', '```',
    '~~~md', '[Example](missing-two.md)', '~~~',
    '    [Example](missing-three.md)',
    '`[Example](missing-four.md)` and ``[Example](missing-five.md)``',
    '``multi-line `code`', '[Example](missing-six.md)``',
    '\\[Escaped](missing-seven.md)',
    '[Web](https://example.com) [Email](mailto:example@example.com) [Anchor](#missing)',
    '[Protocol relative](//example.com/path)',
  ].join('\n');
  const root = await fixture(t, content);
  assert.deepEqual(await validateDevContext(root), []);
});

test('does not inspect unrelated old documentation', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs/old.md'), '# Historical document\n[Old broken link](gone.md)\n');
  assert.deepEqual(await validateDevContext(root), []);
});

test('follows Markdown links transitively and handles repeated links and cycles', async (t) => {
  const root = await fixture(t, metadata + '[Guide](../guide.md) [Again](../guide.md)\n');
  await writeFile(join(root, 'docs/guide.md'), '[Nested](details.MD)\n[Back](dev/README.md)\n');
  await writeFile(join(root, 'docs/details.MD'), '[Broken](gone.md)\n[Cycle](guide.md)\n');
  assert.deepEqual(await validateDevContext(root), ['docs/details.MD:1: link target does not exist: gone.md']);
});

test('rejects draft and historical metadata in every development document', async (t) => {
  const root = await fixture(t);
  for (const status of ['draft', 'historical', 'deprecated']) {
    await writeFile(join(root, `docs/dev/${status}.md`), metadata.replace('status: active', `status: ${status}`));
  }
  const errors = await validateDevContext(root);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((error) => error.includes('status must be active in development context')));
});

test('rejects inactive documents reached through an intermediate guide', async (t) => {
  const root = await fixture(t, metadata + '[Guide](../guide.md)\n');
  await writeFile(join(root, 'docs/guide.md'), '[Old](old.md)\n');
  for (const status of ['historical', 'draft', 'deprecated']) {
    await writeFile(join(root, 'docs/old.md'), metadata.replace('status: active', `status: '${status}' # note`));
    assert.deepEqual(await validateDevContext(root), [`docs/old.md: inactive document in development context: status ${status} is not active`]);
  }
  await writeFile(join(root, 'docs/old.md'), '# Previous architecture\n\n> **已退役的历史设计**：旧实现已移除。\n');
  assert.deepEqual(await validateDevContext(root), ['docs/old.md: inactive document in development context: explicit historical or retired document banner']);
});

test('rejects archive files and directories even without retirement metadata', async (t) => {
  const root = await fixture(t, metadata + '[Guide](../guide.md)\n');
  await mkdir(join(root, 'docs/archive'));
  await writeFile(join(root, 'docs/archive/old.md'), '# Old\n');
  await writeFile(join(root, 'docs/guide.md'), '[Old](archive/old.md)\n[Directory](archive/)\n');
  assert.deepEqual(await validateDevContext(root), [
    'docs/guide.md:1: link to archived context is not allowed: archive/old.md',
    'docs/guide.md:2: link to archived context is not allowed: archive/',
  ]);
});

test('allows current discussion of historical behavior and code examples of old banners', async (t) => {
  const root = await fixture(t, metadata + [
    'This current guide explains historical decisions and deprecated aliases.',
    '> Current behavior: the deprecated alias is supported for one release.',
    '```md', '> **历史文档**：旧实现。', '```',
  ].join('\n'));
  assert.deepEqual(await validateDevContext(root), []);
});

test('rejects directory symlinks escaping the repository or hiding archive targets', async (t) => {
  const root = await fixture(t, metadata + '[Outside](../escape/missing.md)\n[Archive alias](../alias/old.md)\n');
  const external = await mkdtemp(join(tmpdir(), 'remi-dev-context-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'missing.md'), '# External\n');
  await mkdir(join(root, 'docs/archive'));
  await writeFile(join(root, 'docs/archive/old.md'), '# Old\n');
  await symlink(external, join(root, 'docs/escape'), 'junction');
  await symlink(join(root, 'docs/archive'), join(root, 'docs/alias'), 'junction');
  assert.deepEqual(await validateDevContext(root), [
    'docs/dev/README.md:6: link escapes repository: ../escape/missing.md',
    'docs/dev/README.md:7: link to archived context is not allowed: ../alias/old.md',
  ]);
});

test('requires entry files and validates nested development documents', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'frontend/README.md'));
  await mkdir(join(root, 'docs/dev/nested'));
  await writeFile(join(root, 'docs/dev/nested/notes.md'), '# Missing metadata\n');
  const errors = await validateDevContext(root);
  assert.ok(errors.includes('frontend/README.md: file does not exist'));
  assert.ok(errors.includes('docs/dev/nested/notes.md: missing YAML frontmatter'));
});
