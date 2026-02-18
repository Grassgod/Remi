"""Configuration loading from environment variables and remi.toml."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib
from pathlib import Path

_DEFAULT_MEMORY_DIR = Path.home() / ".remi" / "memory"
_CONFIG_FILENAME = "remi.toml"


@dataclass
class EngineConfig:
    """Configuration for an AI engine."""

    name: str = "claude_cli"
    fallback: str | None = None
    allowed_tools: list[str] = field(default_factory=list)
    model: str | None = None
    timeout: int = 300


@dataclass
class FeishuConfig:
    """Feishu connector configuration."""

    app_id: str = ""
    app_secret: str = ""
    verification_token: str = ""
    encrypt_key: str = ""
    port: int = 9000


@dataclass
class SchedulerConfig:
    """Scheduler configuration."""

    memory_compact_cron: str = "0 3 * * *"
    heartbeat_interval: int = 300


@dataclass
class RemiConfig:
    """Top-level Remi configuration."""

    engine: EngineConfig = field(default_factory=EngineConfig)
    feishu: FeishuConfig = field(default_factory=FeishuConfig)
    scheduler: SchedulerConfig = field(default_factory=SchedulerConfig)
    memory_dir: Path = _DEFAULT_MEMORY_DIR
    pid_file: Path = Path.home() / ".remi" / "remi.pid"
    log_level: str = "INFO"


def load_config(config_path: Path | None = None) -> RemiConfig:
    """Load configuration from environment variables and optional remi.toml.

    Priority: environment variables > remi.toml > defaults.
    """
    file_data: dict = {}
    if config_path and config_path.exists():
        file_data = tomllib.loads(config_path.read_text())
    else:
        # Search current dir and ~/.remi/
        for candidate in [Path.cwd() / _CONFIG_FILENAME, Path.home() / ".remi" / _CONFIG_FILENAME]:
            if candidate.exists():
                file_data = tomllib.loads(candidate.read_text())
                break

    engine_data = file_data.get("engine", {})
    feishu_data = file_data.get("feishu", {})
    scheduler_data = file_data.get("scheduler", {})

    config = RemiConfig(
        engine=EngineConfig(
            name=os.getenv("REMI_BACKEND", engine_data.get("name", "claude_cli")),
            fallback=os.getenv("REMI_FALLBACK", engine_data.get("fallback")),
            allowed_tools=engine_data.get("allowed_tools", []),
            model=os.getenv("REMI_MODEL", engine_data.get("model")),
            timeout=int(os.getenv("REMI_TIMEOUT", engine_data.get("timeout", 300))),
        ),
        feishu=FeishuConfig(
            app_id=os.getenv("FEISHU_APP_ID", feishu_data.get("app_id", "")),
            app_secret=os.getenv("FEISHU_APP_SECRET", feishu_data.get("app_secret", "")),
            verification_token=os.getenv(
                "FEISHU_VERIFICATION_TOKEN", feishu_data.get("verification_token", "")
            ),
            encrypt_key=os.getenv("FEISHU_ENCRYPT_KEY", feishu_data.get("encrypt_key", "")),
            port=int(os.getenv("FEISHU_PORT", feishu_data.get("port", 9000))),
        ),
        scheduler=SchedulerConfig(
            memory_compact_cron=scheduler_data.get("memory_compact_cron", "0 3 * * *"),
            heartbeat_interval=int(
                os.getenv("REMI_HEARTBEAT", scheduler_data.get("heartbeat_interval", 300))
            ),
        ),
        memory_dir=Path(os.getenv("REMI_MEMORY_DIR", str(_DEFAULT_MEMORY_DIR))),
        log_level=os.getenv("REMI_LOG_LEVEL", file_data.get("log_level", "INFO")),
    )
    return config
