/**
 * Stop hook entry point — DEPRECATED.
 *
 * Previously wrote transcript to ~/.remi/queue/ for async memory extraction.
 * No longer needed: Claude Code CLI writes complete JSONL to ~/.claude/projects/
 * in real-time, and Remi's conversations table links to it via cli_request_id.
 *
 * This file is kept as a no-op so existing Claude Code hook config doesn't error.
 */

// No-op: CLI JSONL is the source of truth now.
