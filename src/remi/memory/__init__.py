"""Memory system v2 — entity memory + Manifest/TOC context assembly.

Layout:
    ~/.remi/memory/
    ├── MEMORY.md                      # Long-term: preferences, decisions, core facts
    ├── entities/
    │   ├── people/                    # Person entities with YAML frontmatter
    │   ├── organizations/             # Organization entities
    │   └── decisions/                 # Decision records
    ├── daily/
    │   └── 2026-02-18.md             # Daily notes (append-only)
    └── .versions/                     # Timestamped backups (10 per entity)

Project memory lives in-repo at `.remi/memory.md`, discovered via `_project_root()`.
"""
