#!/usr/bin/env node
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'TESTING.md', 'frontend/AGENTS.md', 'frontend/CLAUDE.md', 'frontend/README.md', 'frontend/README.zh-CN.md', 'frontend/CONTRIBUTING.md'];

function outside(root, target) {
  const path = relative(root, target);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

// This deliberately validates a small metadata contract, not arbitrary YAML.
function metadataErrors(text) {
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!block) return ['missing YAML frontmatter'];
  const errors = [];
  for (const key of ['title', 'status', 'summary']) {
    const field = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block[1]);
    let value = field?.[1].trim() ?? '';
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.lastIndexOf(quote);
      value = end > 0 ? value.slice(1, end).trim() : '';
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
      if (value.startsWith('#') || /^(?:null|~)$/i.test(value)) value = '';
    }
    if (!value) errors.push(`frontmatter ${key} must be non-empty`);
    else if (key === 'status' && value !== 'active') {
      errors.push('frontmatter status must be active in development context');
    } else if (/^[|>][+-]?$/.test(value)) {
      const rest = block[1].slice(field.index + field[0].length);
      if (!/^\r?\n(?:[ \t]*\r?\n)*[ \t]+\S/.test(rest)) {
        errors.push(`frontmatter ${key} must be non-empty`);
      }
    }
  }
  return errors;
}

function inactiveContext(text) {
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const status = block && /^status:[ \t]*([^\r\n]*)/m.exec(block[1]);
  if (status) {
    const value = status[1].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (value !== 'active') return `status ${value || '(empty)'} is not active`;
  }
  // Only explicit retirement banners near the start count; ordinary discussion
  // of history, migrations, or deprecated API behavior is valid current context.
  const head = hideCode(text).split('\n').slice(0, 30).join('\n');
  if (/^ {0,3}>\s*(?:\*\*|__)?(?:历史文档|历史设计|已退役|已废弃|已归档|废弃文档|过时文档|historical(?:\s+(?:document|design))?\b|deprecated\b|retired\b|archived\b)/im.test(head)) {
    return 'explicit historical or retired document banner';
  }
  return null;
}

function archivePath(root, file) {
  return relative(root, file).split(/[\\/]/).some((segment) => /^(?:archive|archives)$/i.test(segment));
}

function hideCode(text) {
  let fence = null;
  const hidden = text.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return ' '.repeat(line.length);
    }
    if (marker) {
      fence = marker[1];
      return ' '.repeat(line.length);
    }
    return /^(?: {4}|\t)/.test(line) ? ' '.repeat(line.length) : line;
  }).join('\n');
  // Code spans close only on a backtick run of the same length.
  const spans = /`+/g;
  let result = hidden;
  for (let opening; (opening = spans.exec(hidden));) {
    if (hidden[opening.index - 1] === '\\') continue;
    const closing = /`+/g;
    closing.lastIndex = spans.lastIndex;
    for (let match; (match = closing.exec(hidden));) {
      if (match[0].length !== opening[0].length) continue;
      const end = closing.lastIndex;
      result = result.slice(0, opening.index) + hidden.slice(opening.index, end).replace(/[^\n]/g, ' ') + result.slice(end);
      spans.lastIndex = end;
      break;
    }
  }
  return result;
}

function destination(raw) {
  const value = raw.trim();
  if (value.startsWith('<')) return /^<([^>]*)>/.exec(value)?.[1] ?? '';
  // Optional Markdown titles follow the destination after whitespace.
  return value.replace(/\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\([^)]*\))\s*$/, '').trim();
}

function links(text) {
  const source = hideCode(text);
  const found = [];
  const inline = /!?\[(?:\\.|[^\]\\]|\[[^\]]*\])*\]\(/g;
  for (let match; (match = inline.exec(source));) {
    if (source[match.index - 1] === '\\') continue;
    const start = inline.lastIndex;
    let depth = 1;
    let angle = false;
    let quote = null;
    let end = start;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === '\\') { end += 1; continue; }
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === '<' && end === start) angle = true;
      if (char === '>') angle = false;
      if (angle) continue;
      if ((char === '"' || char === "'") && /\s/.test(source[end - 1] ?? '')) { quote = char; continue; }
      if (char === '(') depth += 1;
      if (char === ')' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    found.push({ target: destination(source.slice(start, end)), offset: match.index });
    inline.lastIndex = end + 1;
  }
  for (const match of source.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(.+)$/gm)) {
    found.push({ target: destination(match[1]), offset: match.index });
  }
  return found;
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (/\.md$/i.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/** Validate the active Markdown closure, not unrelated historical documents. */
export async function validateDevContext(repoRoot) {
  const root = await realpath(resolve(repoRoot));
  const errors = [];
  let docs = [];
  try {
    const directory = resolve(root, 'docs/dev');
    if (outside(root, await realpath(directory))) errors.push('docs/dev: directory escapes repository');
    else docs = await markdownFiles(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    errors.push('docs/dev: directory does not exist');
  }
  const metadataFiles = new Set(docs);
  const files = [...new Set([...ENTRY_FILES.map((path) => resolve(root, path)), ...docs])];
  const queued = new Set(files);
  const visited = new Set();
  for (const file of files) {
    const label = relative(root, file).split(sep).join('/');
    let text;
    try {
      const canonical = await realpath(file);
      if (outside(root, canonical)) {
        errors.push(`${label}: file escapes repository`);
        continue;
      }
      if (archivePath(root, file) || archivePath(root, canonical)) {
        errors.push(`${label}: archived documents cannot be part of active development context`);
        continue;
      }
      if (visited.has(canonical) && !metadataFiles.has(file)) continue;
      visited.add(canonical);
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      errors.push(`${label}: file does not exist`);
      continue;
    }
    if (metadataFiles.has(file)) {
      errors.push(...metadataErrors(text).map((error) => `${label}: ${error}`));
    }
    const inactive = inactiveContext(text);
    if (inactive) {
      // docs/dev status errors are already reported by its metadata contract.
      if (!metadataFiles.has(file) || !inactive.startsWith('status ')) {
        errors.push(`${label}: inactive document in development context: ${inactive}`);
      }
      continue;
    }
    for (const { target, offset } of links(text)) {
      const location = `${label}:${text.slice(0, offset).split('\n').length}`;
      if (!target || target.startsWith('#') || target.startsWith('//')) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[/\\]/i.test(target)) continue;
      let path;
      try {
        path = decodeURIComponent(target.split(/[?#]/, 1)[0]).replace(/\\([ !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
      } catch {
        errors.push(`${location}: invalid link encoding: ${target}`);
        continue;
      }
      const resolved = resolve(dirname(file), path);
      if (isAbsolute(path) || /^[a-z]:[/\\]/i.test(path) || outside(root, resolved)) {
        errors.push(`${location}: link escapes repository: ${target}`);
        continue;
      }
      try {
        const targetStat = await stat(resolved);
        const canonical = await realpath(resolved);
        if (outside(root, canonical)) {
          errors.push(`${location}: link escapes repository: ${target}`);
          continue;
        }
        if (archivePath(root, resolved) || archivePath(root, canonical)) {
          errors.push(`${location}: link to archived context is not allowed: ${target}`);
          continue;
        }
        if (targetStat.isFile() && /\.md$/i.test(resolved) && !queued.has(resolved)) {
          queued.add(resolved);
          files.push(resolved);
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        errors.push(`${location}: link target does not exist: ${target}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const errors = await validateDevContext(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    if (errors.length) {
      console.error(['Development context validation failed:', ...errors.map((error) => `- ${error}`)].join('\n'));
      process.exitCode = 1;
    } else console.log('Development context validation passed.');
  } catch (error) {
    console.error(`Development context validation could not run: ${error.message}`);
    process.exitCode = 2;
  }
}
