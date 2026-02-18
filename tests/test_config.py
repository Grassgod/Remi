"""Tests for configuration loading."""

import pytest
from pathlib import Path

from remi.config import load_config


class TestConfig:
    def test_defaults(self, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        for key in ["REMI_BACKEND", "REMI_FALLBACK", "REMI_MODEL", "REMI_TIMEOUT"]:
            monkeypatch.delenv(key, raising=False)

        config = load_config()
        assert config.engine.name == "claude_cli"
        assert config.engine.timeout == 300
        assert config.memory_dir.name == "memory"

    def test_env_override(self, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("REMI_BACKEND", "anthropic_api")
        monkeypatch.setenv("REMI_TIMEOUT", "60")

        config = load_config()
        assert config.engine.name == "anthropic_api"
        assert config.engine.timeout == 60

    def test_toml_file(self, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        for key in ["REMI_BACKEND", "REMI_FALLBACK", "REMI_MODEL", "REMI_TIMEOUT"]:
            monkeypatch.delenv(key, raising=False)

        toml_path = tmp_path / "remi.toml"
        toml_path.write_text("""
[engine]
name = "claude_sdk"
timeout = 120

[feishu]
app_id = "test-app"
port = 8080
""")
        config = load_config(toml_path)
        assert config.engine.name == "claude_sdk"
        assert config.engine.timeout == 120
        assert config.feishu.app_id == "test-app"
        assert config.feishu.port == 8080

    def test_env_overrides_toml(self, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("REMI_BACKEND", "anthropic_api")

        toml_path = tmp_path / "remi.toml"
        toml_path.write_text("""
[engine]
name = "claude_sdk"
""")
        config = load_config(toml_path)
        assert config.engine.name == "anthropic_api"  # env wins
