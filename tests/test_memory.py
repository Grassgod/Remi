"""Tests for the v2 memory system."""

from __future__ import annotations

import pytest
from pathlib import Path

from remi.memory.store import MemoryStore, CONTEXT_WARN_THRESHOLD


@pytest.fixture
def store(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "memory")


class TestEnsureInitialized:
    def test_creates_directory_structure(self, store: MemoryStore):
        assert (store.root / "entities" / "people").is_dir()
        assert (store.root / "entities" / "organizations").is_dir()
        assert (store.root / "entities" / "decisions").is_dir()
        assert (store.root / "daily").is_dir()
        assert (store.root / ".versions").is_dir()

    def test_creates_initial_memory_md(self, store: MemoryStore):
        content = store.read_memory()
        assert "个人记忆" in content
        assert "用户偏好" in content

    def test_idempotent(self, store: MemoryStore):
        store._ensure_initialized()
        store._ensure_initialized()
        # Should not fail or duplicate
        assert (store.root / "entities" / "people").is_dir()


class TestMemoryIndex:
    def test_build_index_empty(self, store: MemoryStore):
        assert store._index == {}

    def test_build_index_with_entity(self, store: MemoryStore):
        store.remember("Alice", "person", "CV expert")
        # Index should have one entry
        assert len(store._index) == 1
        values = list(store._index.values())
        assert values[0]["name"] == "Alice"
        assert values[0]["type"] == "person"

    def test_invalidate_index(self, store: MemoryStore):
        result = store.remember("Bob", "person", "Backend dev")
        assert "已创建" in result
        # Modify and re-index
        path = store._find_entity_by_name("Bob")
        assert path is not None
        store._invalidate_index(path)
        assert store._index[str(path)]["name"] == "Bob"


class TestFrontmatter:
    def test_parse_normal(self, store: MemoryStore):
        store.remember("Alice", "person", "Test observation")
        path = store._find_entity_by_name("Alice")
        meta = store._parse_frontmatter(path)
        assert meta["type"] == "person"
        assert meta["name"] == "Alice"
        assert meta["source"] == "user-explicit"

    def test_parse_missing_file(self, store: MemoryStore):
        meta = store._parse_frontmatter(store.root / "nonexistent.md")
        assert meta == {}

    def test_parse_malformed(self, store: MemoryStore):
        bad_file = store.root / "bad.md"
        bad_file.write_text("no frontmatter here", encoding="utf-8")
        meta = store._parse_frontmatter(bad_file)
        # Should return empty dict or partial, not crash
        assert isinstance(meta, dict)


class TestSlugify:
    def test_english(self, store: MemoryStore):
        assert store._slugify("Alice Chen") == "Alice-Chen"

    def test_chinese(self, store: MemoryStore):
        assert store._slugify("王伟") == "王伟"

    def test_special_chars(self, store: MemoryStore):
        assert store._slugify('foo<>:"/\\|?*bar') == "foobar"

    def test_empty_string(self, store: MemoryStore):
        assert store._slugify("") == "unnamed"

    def test_mixed(self, store: MemoryStore):
        assert store._slugify("Hub-spoke 架构") == "Hub-spoke-架构"


class TestResolvePath:
    def test_new_entity(self, store: MemoryStore):
        base = store.root / "entities"
        path = store._resolve_path("Alice", "person", base)
        assert path == base / "people" / "Alice.md"

    def test_existing_match(self, store: MemoryStore):
        store.remember("Alice", "person", "First obs")
        base = store.root / "entities"
        path = store._resolve_path("Alice", "person", base)
        # Should return existing file
        assert path.exists()

    def test_collision(self, store: MemoryStore):
        base = store.root / "entities"
        # Create a file with same slug but different frontmatter name
        type_dir = base / "people"
        type_dir.mkdir(parents=True, exist_ok=True)
        (type_dir / "Alice.md").write_text("---\nname: Alice Other\n---\n", encoding="utf-8")
        path = store._resolve_path("Alice", "person", base)
        assert path.name == "Alice-2.md"


class TestEntityCRUD:
    def test_render_new_entity(self, store: MemoryStore):
        content = store._render_new_entity("Alice", "person", "CV expert")
        assert "type: person" in content
        assert "name: Alice" in content
        assert "source: agent-inferred" in content
        assert "## 备注" in content
        assert "CV expert" in content

    def test_append_observation(self, store: MemoryStore):
        store.remember("Alice", "person", "Initial")
        path = store._find_entity_by_name("Alice")
        store._append_observation(path, "New observation")
        content = path.read_text(encoding="utf-8")
        assert "New observation" in content
        assert "## 备注" in content

    def test_update_frontmatter_timestamp(self, store: MemoryStore):
        store.remember("Alice", "person", "Initial")
        path = store._find_entity_by_name("Alice")
        store._update_frontmatter_timestamp(path)
        new_content = path.read_text(encoding="utf-8")
        # The updated field should change (or at least not crash)
        assert "updated:" in new_content


class TestBackup:
    def test_backup_created(self, store: MemoryStore):
        store.remember("Alice", "person", "Initial")
        path = store._find_entity_by_name("Alice")
        store._backup(path)
        versions = list((store.root / ".versions").glob("Alice-*.md"))
        assert len(versions) >= 1

    def test_backup_cleanup_10_versions(self, store: MemoryStore):
        store.remember("Alice", "person", "Initial")
        path = store._find_entity_by_name("Alice")
        # Create 15 backups
        for i in range(15):
            backup = store.root / ".versions" / f"Alice-2026{i:04d}T000000.md"
            backup.write_text(f"v{i}", encoding="utf-8")
        store._backup(path)
        versions = list((store.root / ".versions").glob("Alice-*.md"))
        assert len(versions) <= 10


class TestRecall:
    def test_exact_name_match(self, store: MemoryStore):
        store.remember("Alice Chen", "person", "CV expert at Acme")
        result = store.recall("Alice Chen")
        # Exact match should return full text
        assert "type: person" in result
        assert "Alice Chen" in result

    def test_aliases_match(self, store: MemoryStore):
        # Create entity with aliases manually
        entity_dir = store.root / "entities" / "people"
        entity_dir.mkdir(parents=True, exist_ok=True)
        content = (
            "---\n"
            "type: person\n"
            "name: Alice Chen\n"
            "created: 2026-01-01T00:00:00\n"
            "updated: 2026-01-01T00:00:00\n"
            "tags: []\n"
            "source: user-explicit\n"
            'summary: "CV expert"\n'
            "aliases: [Alice, AC]\n"
            "related: []\n"
            "---\n\n# Alice Chen\n"
        )
        (entity_dir / "Alice-Chen.md").write_text(content, encoding="utf-8")
        store._build_index()

        result = store.recall("Alice")
        assert result  # Should find via alias

    def test_body_substring(self, store: MemoryStore):
        store.remember("Bob", "person", "works on PaddleOCR pipeline")
        result = store.recall("PaddleOCR")
        assert "Bob" in result

    def test_type_filter(self, store: MemoryStore):
        store.remember("Alice", "person", "engineer")
        store.remember("Acme", "organization", "tech company")
        result = store.recall("engineer", type="person")
        assert "Alice" in result
        # Organization should be filtered out if it doesn't match
        assert "Acme" not in result or "person" in result

    def test_tags_filter(self, store: MemoryStore):
        # Create entity with tags
        entity_dir = store.root / "entities" / "people"
        content = (
            "---\n"
            "type: person\n"
            "name: Tagged Person\n"
            "created: 2026-01-01T00:00:00\n"
            "updated: 2026-01-01T00:00:00\n"
            "tags: [colleague, cv-expert]\n"
            "source: user-explicit\n"
            'summary: ""\n'
            "aliases: []\n"
            "related: []\n"
            "---\n\n# Tagged Person\n"
        )
        (entity_dir / "Tagged-Person.md").write_text(content, encoding="utf-8")
        store._build_index()

        result = store.recall("Tagged Person", tags=["colleague"])
        assert "Tagged Person" in result

    def test_daily_log_search(self, store: MemoryStore):
        store.append_daily("discussed PaddleOCR optimization", date="2026-02-17")
        result = store.recall("PaddleOCR")
        assert "2026-02-17" in result

    def test_project_memory_search(self, store: MemoryStore, tmp_path: Path):
        # Create a project with .remi/memory.md
        project = tmp_path / "myproject"
        (project / ".remi").mkdir(parents=True)
        (project / ".remi" / "memory.md").write_text(
            "# MyProject — Hub-spoke architecture\n", encoding="utf-8"
        )
        result = store.recall("Hub-spoke", cwd=str(project))
        assert result  # Should find in project memory

    def test_no_match(self, store: MemoryStore):
        result = store.recall("nonexistent-query-12345")
        assert result == ""


class TestRemember:
    def test_create_new_entity(self, store: MemoryStore):
        result = store.remember("Alice", "person", "CV expert")
        assert "已创建" in result
        path = store._find_entity_by_name("Alice")
        assert path is not None
        assert path.exists()

    def test_append_observation(self, store: MemoryStore):
        store.remember("Alice", "person", "CV expert")
        result = store.remember("Alice", "person", "prefers Slack")
        assert "已更新" in result
        path = store._find_entity_by_name("Alice")
        content = path.read_text(encoding="utf-8")
        assert "CV expert" in content
        assert "prefers Slack" in content

    def test_scope_project(self, store: MemoryStore, tmp_path: Path):
        project = tmp_path / "myproject"
        (project / ".remi").mkdir(parents=True)
        (project / ".remi" / "memory.md").write_text("# Project\n", encoding="utf-8")
        result = store.remember(
            "Decision X", "decision", "chose option A", scope="project", cwd=str(project)
        )
        assert "已创建" in result
        # Entity should be in project entities dir
        entity_files = list((project / ".remi" / "entities").rglob("*.md"))
        assert len(entity_files) == 1

    def test_scope_project_no_cwd_error(self, store: MemoryStore):
        result = store.remember("Test", "person", "obs", scope="project")
        assert "错误" in result


class TestGatherContext:
    def test_default_two_layers(self, store: MemoryStore, tmp_path: Path):
        # Set up project memory
        project = tmp_path / "myproject"
        (project / ".remi").mkdir(parents=True)
        (project / ".remi" / "memory.md").write_text(
            "# MyProject — test project\n", encoding="utf-8"
        )
        store.write_memory("# 个人记忆\n\nUser preference: dark mode")
        ctx = store.gather_context(cwd=str(project))
        assert "个人记忆" in ctx
        assert "MyProject" in ctx

    def test_module_layer(self, store: MemoryStore, tmp_path: Path):
        # Set up project root + module memory
        project = tmp_path / "myproject"
        module = project / "src" / "module"
        (project / ".remi").mkdir(parents=True)
        (project / ".remi" / "memory.md").write_text("# Root project\n", encoding="utf-8")
        (module / ".remi").mkdir(parents=True)
        (module / ".remi" / "memory.md").write_text("# Module memory\n", encoding="utf-8")
        ctx = store.gather_context(cwd=str(module))
        assert "当前模块记忆" in ctx
        assert "Module memory" in ctx

    def test_warn_threshold(self, store: MemoryStore):
        # Write a large memory to trigger warning
        store.write_memory("x" * (CONTEXT_WARN_THRESHOLD + 100))
        ctx = store.gather_context()
        assert "⚠️" in ctx

    def test_empty_context(self, tmp_path: Path):
        # Fresh store with only initial MEMORY.md
        s = MemoryStore(tmp_path / "fresh_memory")
        ctx = s.gather_context()
        # Should have at least the default MEMORY.md content
        assert "个人记忆" in ctx


class TestProjectRoot:
    def test_highest_layer_found(self, tmp_path: Path):
        store = MemoryStore(tmp_path / "memory")
        # Create nested .remi dirs
        root = tmp_path / "project"
        child = root / "src" / "module"
        (root / ".remi").mkdir(parents=True)
        (child / ".remi").mkdir(parents=True)
        result = store._project_root(str(child))
        assert result == root

    def test_no_remi_returns_none(self, tmp_path: Path):
        store = MemoryStore(tmp_path / "memory")
        result = store._project_root(str(tmp_path / "no_project"))
        assert result is None


class TestBuildManifest:
    def test_entity_summary(self, store: MemoryStore):
        store.remember("Alice", "person", "CV expert")
        manifest = store._build_manifest()
        assert "Alice" in manifest
        assert "实体" in manifest

    def test_daily_entry(self, store: MemoryStore):
        store.append_daily("test log entry", date="2026-02-18")
        manifest = store._build_manifest()
        assert "日志" in manifest
        assert "daily/" in manifest

    def test_project_memory_summary(self, store: MemoryStore, tmp_path: Path):
        # Create project with module that has its own .remi/
        project = tmp_path / "proj"
        module = project / "src" / "mod"
        (project / ".remi").mkdir(parents=True)
        (project / ".remi" / "memory.md").write_text("# Project root\n", encoding="utf-8")
        (module / ".remi").mkdir(parents=True)
        (module / ".remi" / "memory.md").write_text("# Module mem\n", encoding="utf-8")

        # When cwd is module, project root should appear in manifest
        manifest = store._build_manifest(cwd=str(module))
        assert "项目记忆" in manifest or "模块记忆" in manifest


class TestMaintenanceMethods:
    def test_create_entity(self, store: MemoryStore):
        store.create_entity("TestEntity", "decision", "chose option A")
        path = store._find_entity_by_name("TestEntity")
        assert path is not None
        assert path.exists()

    def test_update_entity(self, store: MemoryStore):
        store.create_entity("TestEntity", "decision", "initial")
        store.update_entity(
            "TestEntity", "---\ntype: decision\nname: TestEntity\nupdated: now\n---\n\n# Updated\n"
        )
        path = store._find_entity_by_name("TestEntity")
        content = path.read_text(encoding="utf-8")
        assert "Updated" in content

    def test_patch_project_memory(self, store: MemoryStore, tmp_path: Path):
        project = tmp_path / "proj"
        (project / ".remi").mkdir(parents=True)
        (project / ".remi" / "memory.md").write_text(
            "# Project\n\n## Architecture\nOld content\n\n## Procedures\nOld procs\n",
            encoding="utf-8",
        )
        store.patch_project_memory(str(project), "Procedures", "New procs", mode="overwrite")
        content = (project / ".remi" / "memory.md").read_text(encoding="utf-8")
        assert "New procs" in content
        assert "Old procs" not in content

    def test_patch_project_memory_append(self, store: MemoryStore, tmp_path: Path):
        project = tmp_path / "proj"
        (project / ".remi").mkdir(parents=True)
        (project / ".remi" / "memory.md").write_text(
            "# Project\n\n## Architecture\nExisting arch\n",
            encoding="utf-8",
        )
        store.patch_project_memory(str(project), "Architecture", "New entry", mode="append")
        content = (project / ".remi" / "memory.md").read_text(encoding="utf-8")
        assert "Existing arch" in content
        assert "New entry" in content

    def test_delete_entity(self, store: MemoryStore):
        store.create_entity("ToDelete", "person", "temporary")
        path = store._find_entity_by_name("ToDelete")
        assert path.exists()
        store.delete_entity("ToDelete")
        assert not path.exists()
        assert store._find_entity_by_name("ToDelete") is None


class TestV1Compat:
    def test_read_memory(self, store: MemoryStore):
        # Initial MEMORY.md should exist from _ensure_initialized
        content = store.read_memory()
        assert "个人记忆" in content

    def test_write_memory(self, store: MemoryStore):
        store.write_memory("# Custom Memory\n\nCustom content")
        assert "Custom content" in store.read_memory()

    def test_append_memory(self, store: MemoryStore):
        store.append_memory("- New fact")
        content = store.read_memory()
        assert "New fact" in content

    def test_read_daily(self, store: MemoryStore):
        assert store.read_daily("2099-01-01") == ""

    def test_append_daily(self, store: MemoryStore):
        store.append_daily("Test entry", date="2026-02-18")
        content = store.read_daily("2026-02-18")
        assert "Test entry" in content

    def test_cleanup_old_versions(self, store: MemoryStore):
        for i in range(10):
            (store.root / ".versions" / f"test_{i}.md").write_text(f"v{i}")
        removed = store.cleanup_old_versions(keep=3)
        assert removed == 7
        remaining = list((store.root / ".versions").glob("*.md"))
        assert len(remaining) == 3
