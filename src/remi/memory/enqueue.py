"""Stop hook entry point — enqueue transcript for async processing.

Usage (Claude Code stop hook):
    python -m remi.memory.enqueue

Reads transcript from stdin, writes to ~/.remi/queue/{timestamp}.jsonl.
Must complete within 5 seconds.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path


def main() -> None:
    queue_dir = Path.home() / ".remi" / "queue"
    queue_dir.mkdir(parents=True, exist_ok=True)

    transcript = sys.stdin.read()
    if not transcript.strip():
        return

    # Idempotency: hash-based dedup
    content_hash = hashlib.sha256(transcript.encode()).hexdigest()[:16]

    processed_file = queue_dir / ".processed"
    if processed_file.exists():
        processed = processed_file.read_text(encoding="utf-8").splitlines()
        if content_hash in processed:
            return  # Already processed

    ts = datetime.now().strftime("%Y%m%dT%H%M%S")
    entry = {"timestamp": ts, "hash": content_hash, "transcript": transcript}

    output_path = queue_dir / f"{ts}.jsonl"
    output_path.write_text(json.dumps(entry, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
