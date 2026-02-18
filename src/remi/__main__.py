"""Entry point: python -m remi [serve]

- No args / "chat": Interactive CLI REPL (development/testing)
- "serve":          Daemon mode (production, with connectors + scheduler)
"""

from __future__ import annotations

import asyncio
import logging
import sys

from remi.config import load_config


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _run_cli() -> None:
    """Interactive CLI REPL mode."""
    config = load_config()
    _setup_logging(config.log_level)

    from remi.connectors.cli import CLIConnector
    from remi.core import Remi
    from remi.daemon import RemiDaemon

    # Build Remi with engine
    daemon = RemiDaemon(config)
    remi = daemon._build_remi()

    # Add CLI connector
    cli = CLIConnector()
    remi.add_connector(cli)

    try:
        asyncio.run(remi.start())
    except KeyboardInterrupt:
        pass


def _run_serve() -> None:
    """Daemon mode — connectors + scheduler."""
    config = load_config()
    _setup_logging(config.log_level)

    from remi.daemon import RemiDaemon

    daemon = RemiDaemon(config)
    asyncio.run(daemon.run())


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "chat"

    if cmd in ("chat", "repl"):
        _run_cli()
    elif cmd == "serve":
        _run_serve()
    else:
        print(f"Usage: python -m remi [chat|serve]")
        print(f"  chat   — Interactive CLI REPL (default)")
        print(f"  serve  — Daemon mode with connectors + scheduler")
        sys.exit(1)


if __name__ == "__main__":
    main()
