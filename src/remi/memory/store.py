"""Memory system v2 — entity memory + Manifest/TOC context assembly.

Markdown files are the source of truth. Entities use YAML frontmatter for
structured metadata. An in-memory index (built once at startup, updated
incrementally on writes) avoids repeated disk scans.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime
from pathlib import Path
from typing import Literal

import frontmatter

logger = logging.getLogger(__name__)

PLURAL_MAP = {"person": "people", "child": "children"}

CONTEXT_WARN_THRESHOLD = 6000


class MemoryStore:
    """Read/write access to the v2 memory system."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._index: dict[str, dict] = {}
        self._ensure_initialized()
        self._build_index()

    # ── 2.1 Initialization ────────────────────────────────────

    def _ensure_initialized(self) -> None:
        """Ensure base directories and files exist. Idempotent."""
        for d in [
            "entities/people",
            "entities/organizations",
            "entities/decisions",
            "daily",
            ".versions",
        ]:
            (self.root / d).mkdir(parents=True, exist_ok=True)

        global_memory = self.root / "MEMORY.md"
        if not global_memory.exists():
            global_memory.write_text(
                "# 个人记忆\n\n## 用户偏好\n\n## 长期目标\n\n## 近期焦点\n",
                encoding="utf-8",
            )

    # ── 2.2 In-memory index ───────────────────────────────────

    def _build_index(self) -> None:
        """Scan entities/ once at startup, build in-memory index."""
        self._index.clear()
        entities_dir = self.root / "entities"
        if not entities_dir.is_dir():
            return
        for md_file in entities_dir.rglob("*.md"):
            meta = self._parse_frontmatter(md_file)
            self._index[str(md_file)] = {
                "type": meta.get("type", ""),
                "name": meta.get("name", md_file.stem),
                "tags": meta.get("tags", []),
                "summary": meta.get("summary", ""),
                "aliases": meta.get("aliases", []),
            }

    def _invalidate_index(self, path: Path) -> None:
        """Update a single index entry after a write."""
        meta = self._parse_frontmatter(path)
        self._index[str(path)] = {
            "type": meta.get("type", ""),
            "name": meta.get("name", path.stem),
            "tags": meta.get("tags", []),
            "summary": meta.get("summary", ""),
            "aliases": meta.get("aliases", []),
        }

    def _parse_frontmatter(self, path: Path) -> dict:
        """Parse YAML frontmatter from a markdown file."""
        try:
            post = frontmatter.load(str(path))
            return dict(post.metadata)
        except Exception:
            return {}

    # ── 2.3 File naming & paths ───────────────────────────────

    def _type_to_dir(self, type_name: str) -> str:
        """Map entity type to directory name (pluralized)."""
        t = type_name.lower()
        if t in PLURAL_MAP:
            return PLURAL_MAP[t]
        return t + "s"

    def _slugify(self, name: str) -> str:
        """Minimal slug: strip illegal chars, spaces to hyphens, keep CJK."""
        slug = re.sub(r'[<>:"/\\|?*\n\r\t]', "", name)
        slug = slug.strip().replace(" ", "-")
        return slug or "unnamed"

    def _resolve_path(self, entity: str, type: str, base_dir: Path) -> Path:
        """Determine entity file path. Match existing by frontmatter name first."""
        type_dir = base_dir / self._type_to_dir(type)
        type_dir.mkdir(parents=True, exist_ok=True)
        slug = self._slugify(entity)

        # Check existing files whose name field matches
        for existing in type_dir.glob(f"{slug}*.md"):
            meta = self._parse_frontmatter(existing)
            if meta.get("name") == entity:
                return existing

        # Generate new path, handle collision
        path = type_dir / f"{slug}.md"
        counter = 2
        while path.exists():
            path = type_dir / f"{slug}-{counter}.md"
            counter += 1
        return path

    # ── 2.4 Entity CRUD (internal) ────────────────────────────

    def _render_new_entity(
        self,
        entity: str,
        type: str,
        observation: str,
        source: Literal["user-explicit", "agent-inferred"] = "agent-inferred",
    ) -> str:
        """Generate markdown content for a new entity file."""
        ts = datetime.now().isoformat(timespec="seconds")
        return (
            f"---\n"
            f"type: {type}\n"
            f"name: {entity}\n"
            f"created: {ts}\n"
            f"updated: {ts}\n"
            f"tags: []\n"
            f"source: {source}\n"
            f'summary: ""\n'
            f"aliases: []\n"
            f"related: []\n"
            f"---\n\n"
            f"# {entity}\n\n"
            f"## 备注\n"
            f"- [{ts[:10]}] {observation}\n"
        )

    def _append_observation(self, path: Path, observation: str) -> None:
        """Append to the ## 备注 section, creating it if absent."""
        content = path.read_text(encoding="utf-8")
        ts = datetime.now().strftime("%Y-%m-%d")
        entry = f"\n- [{ts}] {observation}"

        if "## 备注" in content:
            content = content.replace("## 备注", f"## 备注{entry}", 1)
        else:
            content += f"\n\n## 备注{entry}"

        path.write_text(content, encoding="utf-8")

    def _update_frontmatter_timestamp(self, path: Path) -> None:
        """Update the 'updated' field in frontmatter."""
        ts = datetime.now().isoformat(timespec="seconds")
        content = path.read_text(encoding="utf-8")
        content = re.sub(
            r"^updated:.*$",
            f"updated: {ts}",
            content,
            flags=re.MULTILINE,
        )
        path.write_text(content, encoding="utf-8")

    def _backup(self, path: Path) -> None:
        """Backup to .versions/, keep at most 10 versions per entity."""
        if not path.exists():
            return
        versions_dir = self.root / ".versions"
        versions_dir.mkdir(exist_ok=True)
        ts = datetime.now().strftime("%Y%m%dT%H%M%S")
        (versions_dir / f"{path.stem}-{ts}.md").write_text(
            path.read_text(encoding="utf-8"), encoding="utf-8"
        )
        # Cleanup old versions for this entity
        old = sorted(versions_dir.glob(f"{path.stem}-*.md"))
        for f in old[:-10]:
            f.unlink()

    # ── 2.5 Hot Path tools ────────────────────────────────────

    def recall(
        self,
        query: str,
        type: str | None = None,
        tags: list[str] | None = None,
        cwd: str | None = None,
    ) -> str:
        """Search all memory sources: entities, daily logs, project memory."""
        results: list[tuple[str, Path, dict]] = []

        # 1. Search entities (index first, then body)
        for path_str, meta in self._index.items():
            if type and meta.get("type") != type:
                continue
            if tags and not set(tags) & set(meta.get("tags", [])):
                continue
            md_file = Path(path_str)
            if self._matches(md_file, query, meta):
                results.append(("entity", md_file, meta))

        # 2. Search daily logs
        daily_dir = self.root / "daily"
        if daily_dir.is_dir():
            for md_file in sorted(daily_dir.glob("*.md"), reverse=True):
                if self._matches_text(md_file, query):
                    results.append(("daily", md_file, {}))

        # 3. Search project memory
        project_root = self._project_root(cwd) if cwd else None
        if project_root:
            for md_file in project_root.rglob(".remi/memory.md"):
                if self._matches_text(md_file, query):
                    results.append(("project", md_file, {}))

        return self._format_results(results, query)

    def remember(
        self,
        entity: str,
        type: str,
        observation: str,
        scope: Literal["personal", "project"] = "personal",
        cwd: str | None = None,
    ) -> str:
        """Immediately save an observation about an entity (Hot Path)."""
        if scope == "project":
            if not cwd:
                return "错误：scope=project 需要提供 cwd"
            project_root = self._project_root(cwd)
            if not project_root:
                return "错误：找不到项目根目录，请先 remi init"
            base_dir = project_root / ".remi" / "entities"
        else:
            base_dir = self.root / "entities"

        path = self._resolve_path(entity, type, base_dir)

        if path.exists():
            self._backup(path)
            self._append_observation(path, observation)
            self._update_frontmatter_timestamp(path)
            self._invalidate_index(path)
            return f"已更新 {entity}：{observation}"
        else:
            content = self._render_new_entity(entity, type, observation, source="user-explicit")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            self._invalidate_index(path)
            return f"已创建 {entity}（{type}）：{observation}"

    def _matches(self, md_file: Path, query: str, meta: dict) -> bool:
        """Check index name + aliases first, then body substring."""
        q = query.lower()

        # Exact name match
        if meta.get("name", "").lower() == q:
            return True

        # Aliases match
        for alias in meta.get("aliases", []):
            if q in alias.lower():
                return True

        # Body substring
        return self._matches_text(md_file, query)

    def _matches_text(self, md_file: Path, query: str) -> bool:
        """Check if query appears in file body (case-insensitive)."""
        try:
            return query.lower() in md_file.read_text(encoding="utf-8").lower()
        except OSError:
            return False

    def _format_results(self, results: list[tuple[str, Path, dict]], query: str) -> str:
        """Format recall results. Exact entity name match → full text, else summary."""
        if not results:
            return ""

        q = query.lower()

        # Check for exact entity name match → return full text
        for source, md_file, meta in results:
            if source == "entity" and meta.get("name", "").lower() == q:
                return md_file.read_text(encoding="utf-8")

        # Otherwise return summary list
        lines = []
        for source, md_file, meta in results:
            if source == "entity":
                name = meta.get("name", md_file.stem)
                etype = meta.get("type", "")
                summary = meta.get("summary", "")
                lines.append(f"- [{source}] {name} ({etype}): {summary}")
            elif source == "daily":
                lines.append(f"- [{source}] {md_file.stem}")
            elif source == "project":
                lines.append(f"- [{source}] {md_file}")
        return "\n".join(lines)

    # ── 3. Manifest/TOC context assembly ──────────────────────

    def gather_context(self, cwd: str | None = None) -> str:
        """Assemble memory context with Manifest/TOC. Replaces read_with_ancestors."""
        self._ensure_initialized()
        context = self._assemble(cwd)
        if len(context) > CONTEXT_WARN_THRESHOLD:
            logger.warning("记忆上下文 %d 字符（阈值：%d）", len(context), CONTEXT_WARN_THRESHOLD)
            context += (
                f"\n\n⚠️ 当前上下文 {len(context)} 字符（阈值：{CONTEXT_WARN_THRESHOLD}），"
                "建议用 recall 替代全文加载，或精简 MEMORY.md 的 ## 近期焦点 章节。"
            )
        return context

    def _assemble(self, cwd: str | None) -> str:
        """Build context: personal memory + project/module memory + daily + manifest."""
        parts: list[str] = []

        # 1. Personal global memory (always injected)
        global_memory = self.root / "MEMORY.md"
        if global_memory.exists():
            content = global_memory.read_text(encoding="utf-8")
            if content.strip():
                parts.append(f"# 个人记忆\n{content}")

        # 2. Project memory: current dir .remi/memory.md if exists, else project root
        project_root = self._project_root(cwd) if cwd else None
        current_memory = Path(cwd) / ".remi" / "memory.md" if cwd else None
        if current_memory and current_memory.exists():
            label = Path(cwd).name
            parts.append(f"# 当前模块记忆 ({label})\n{current_memory.read_text(encoding='utf-8')}")
        elif project_root:
            root_memory = project_root / ".remi" / "memory.md"
            if root_memory.exists():
                parts.append(
                    f"# 项目记忆 ({project_root.name})\n{root_memory.read_text(encoding='utf-8')}"
                )

        # 3. Today's daily log
        today = date.today().isoformat()
        daily_file = self.root / "daily" / f"{today}.md"
        if daily_file.exists():
            content = daily_file.read_text(encoding="utf-8")
            if content.strip():
                parts.append(f"# 当日日志\n{content}")

        # 4. Manifest
        manifest = self._build_manifest(cwd)
        if manifest:
            parts.append(manifest)

        return "\n\n---\n\n".join(parts) if parts else ""

    def _project_root(self, cwd: str) -> Path | None:
        """Walk up from cwd, return the highest directory containing .remi/."""
        p = Path(cwd)
        root = None
        while p != p.parent:
            if (p / ".remi").is_dir():
                root = p
            p = p.parent
        return root

    def _build_manifest(self, cwd: str | None = None) -> str:
        """Generate a summary table from the in-memory index and project memories."""
        rows: list[dict[str, str]] = []

        # 1. Project .remi/memory.md files (excluding the one already loaded in full)
        project_root = self._project_root(cwd) if cwd else None
        current_memory = Path(cwd) / ".remi" / "memory.md" if cwd else None
        if project_root:
            for md_file in project_root.rglob(".remi/memory.md"):
                if current_memory and md_file == current_memory:
                    continue
                # Skip the project root memory if it was already loaded in full
                # (i.e., when there's no current_memory and we loaded project root)
                if (
                    not (current_memory and current_memory.exists())
                    and md_file == project_root / ".remi" / "memory.md"
                ):
                    continue
                summary = self._read_first_line(md_file)
                rel = md_file.relative_to(project_root)
                source = "项目记忆" if md_file.parent.parent == project_root else "模块记忆"
                rows.append({"source": source, "name": str(rel), "summary": summary})

        # 2. Entity directory (from in-memory index, O(1))
        for path_str, meta in self._index.items():
            rows.append(
                {
                    "source": "实体",
                    "name": f"{meta['name']} ({meta['type']})",
                    "summary": meta["summary"],
                }
            )

        # 3. Daily log entry
        daily_dir = self.root / "daily"
        if daily_dir.is_dir():
            days = sorted(daily_dir.glob("*.md"), reverse=True)
            if days:
                rows.append(
                    {
                        "source": "日志",
                        "name": "daily/",
                        "summary": (
                            f'最近 {min(len(days), 7)} 天可用，recall("日期或关键词") 查看'
                        ),
                    }
                )

        if not rows:
            return ""
        header = "# 可用记忆（使用 recall 工具查看详情）\n\n"
        header += "| 来源 | 路径/名称 | 摘要 |\n|------|----------|------|\n"
        for r in rows:
            header += f"| {r['source']} | {r['name']} | {r['summary']} |\n"
        return header

    def _read_first_line(self, md_file: Path) -> str:
        """Read the first non-empty line as a manifest summary."""
        try:
            for line in md_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    return line.lstrip("# ").strip()
            return ""
        except OSError:
            return ""

    # ── 2.6 Maintenance agent internal methods ────────────────

    def create_entity(
        self,
        name: str,
        type: str,
        content: str,
        source: Literal["user-explicit", "agent-inferred"] = "agent-inferred",
    ) -> None:
        """Create a new entity file. Used by maintenance agent."""
        base_dir = self.root / "entities"
        path = self._resolve_path(name, type, base_dir)
        if path.exists():
            logger.warning("Entity %s already exists at %s", name, path)
            return
        rendered = self._render_new_entity(name, type, content, source=source)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")
        self._invalidate_index(path)
        logger.info("Created entity: %s (%s)", name, type)

    def update_entity(self, name: str, content: str) -> None:
        """Overwrite entity file content (auto-backup). Used by maintenance agent."""
        path = self._find_entity_by_name(name)
        if not path:
            logger.warning("Entity %s not found for update", name)
            return
        self._backup(path)
        path.write_text(content, encoding="utf-8")
        self._update_frontmatter_timestamp(path)
        self._invalidate_index(path)
        logger.info("Updated entity: %s", name)

    def append_observation(self, name: str, observation: str) -> None:
        """Append observation to an entity's ## 备注 section. Public wrapper."""
        path = self._find_entity_by_name(name)
        if not path:
            logger.warning("Entity %s not found for observation", name)
            return
        self._backup(path)
        self._append_observation(path, observation)
        self._update_frontmatter_timestamp(path)
        self._invalidate_index(path)

    def patch_project_memory(
        self,
        project_path: str,
        section: str,
        content: str,
        mode: Literal["append", "overwrite"] = "append",
    ) -> None:
        """Patch a specific section in a project's .remi/memory.md."""
        memory_file = Path(project_path) / ".remi" / "memory.md"
        if not memory_file.exists():
            logger.warning("Project memory not found: %s", memory_file)
            return

        self._backup(memory_file)
        text = memory_file.read_text(encoding="utf-8")

        section_header = f"## {section}"
        if section_header in text:
            # Find the section and the next section
            pattern = rf"(## {re.escape(section)}\n)(.*?)(?=\n## |\Z)"
            match = re.search(pattern, text, re.DOTALL)
            if match:
                if mode == "overwrite":
                    replacement = f"{section_header}\n{content}\n"
                else:  # append
                    existing = match.group(2).rstrip()
                    replacement = f"{section_header}\n{existing}\n{content}\n"
                text = text[: match.start()] + replacement + text[match.end() :]
        else:
            # Section doesn't exist — append at end
            text = text.rstrip() + f"\n\n{section_header}\n{content}\n"

        memory_file.write_text(text, encoding="utf-8")
        logger.info("Patched project memory section '%s' (%s)", section, mode)

    def delete_entity(self, name: str) -> None:
        """Delete an entity file (auto-backup)."""
        path = self._find_entity_by_name(name)
        if not path:
            logger.warning("Entity %s not found for deletion", name)
            return
        self._backup(path)
        path.unlink()
        self._index.pop(str(path), None)
        logger.info("Deleted entity: %s", name)

    def _find_entity_by_name(self, name: str) -> Path | None:
        """Look up an entity path by its frontmatter name."""
        for path_str, meta in self._index.items():
            if meta.get("name") == name:
                return Path(path_str)
        return None

    # ── 2.7 v1 compat ────────────────────────────────────────

    @property
    def memory_file(self) -> Path:
        return self.root / "MEMORY.md"

    def read_memory(self) -> str:
        """Read the root MEMORY.md."""
        if self.memory_file.exists():
            return self.memory_file.read_text(encoding="utf-8")
        return ""

    def write_memory(self, content: str) -> None:
        """Overwrite root MEMORY.md with version backup."""
        self._backup(self.memory_file)
        self.memory_file.write_text(content, encoding="utf-8")
        logger.info("Updated MEMORY.md (%d chars)", len(content))

    def append_memory(self, entry: str) -> None:
        """Append an entry to root MEMORY.md."""
        self._backup(self.memory_file)
        with self.memory_file.open("a", encoding="utf-8") as f:
            f.write(f"\n{entry.rstrip()}\n")

    def _daily_path(self, date: str | None = None) -> Path:
        d = date or datetime.now().strftime("%Y-%m-%d")
        return self.root / "daily" / f"{d}.md"

    def read_daily(self, date: str | None = None) -> str:
        """Read today's (or specified date's) daily notes."""
        path = self._daily_path(date)
        if path.exists():
            return path.read_text(encoding="utf-8")
        return ""

    def append_daily(self, entry: str, date: str | None = None) -> None:
        """Append an entry to today's daily notes."""
        path = self._daily_path(date)
        timestamp = datetime.now().strftime("%H:%M")
        with path.open("a", encoding="utf-8") as f:
            if not path.exists() or path.stat().st_size == 0:
                f.write(f"# {date or datetime.now().strftime('%Y-%m-%d')}\n\n")
            f.write(f"- [{timestamp}] {entry.rstrip()}\n")

    def cleanup_old_dailies(self, keep_days: int = 30) -> int:
        """Remove daily notes older than keep_days. Returns count removed."""
        from datetime import timedelta

        cutoff = datetime.now() - timedelta(days=keep_days)
        removed = 0
        for path in (self.root / "daily").glob("*.md"):
            try:
                d = datetime.strptime(path.stem, "%Y-%m-%d")
                if d < cutoff:
                    path.unlink()
                    removed += 1
            except ValueError:
                continue
        return removed

    def cleanup_old_versions(self, keep: int = 50) -> int:
        """Keep only the most recent `keep` version files."""
        versions = sorted(
            (self.root / ".versions").glob("*"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        removed = 0
        for path in versions[keep:]:
            path.unlink()
            removed += 1
        return removed
