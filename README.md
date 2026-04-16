# cc-background-compactor

Proactive, non-blocking context compaction for Claude Code.

Claude Code has a built-in auto-compact that triggers near 95% context fill — but it's synchronous and interrupts your flow for 30-60 seconds while it summarizes. This plugin runs the same summarization **in the background** at a lower threshold (default 70%), then splices the summary into your transcript the next time the session is idle between turns. You never wait.

## How it works

1. **Stop hook fires** at the end of every turn.
2. Reads the latest `assistant` usage tokens from your session's JSONL transcript.
3. If context fill is over your configured threshold:
   - Spawns a detached background process that reads the oldest N% of messages, runs `claude -p` to summarize them, and writes the result to a temp file.
   - Uses the **same model and env** (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, etc.) as your active session, so it works with third-party providers, Kiro, proxies, auto-model routing, and so on.
4. **Next Stop hook** finds the pending summary and splices it into the JSONL atomically: a proper `compact_boundary` system message + summary + reparented remaining messages.
5. On your next turn, Claude Code loads the compacted transcript and the summarization is already done.

Because it's event-driven and never blocks the session, you can keep working straight through context filling up.

### The catch: Claude Code caches the conversation in memory

CC reads the JSONL once at session start and never re-reads it. So when the plugin splices a summary into the JSONL mid-session, the running TUI doesn't see it — the context indicator stays at 70%, API calls still send the full pre-splice transcript, and cost doesn't drop. The splice only takes effect on the **next** `--resume`.

For Agent SDK / orcd use, where each turn rebuilds the API payload from the JSONL, mid-session splices work in-flight. For interactive CC, see the `cch` wrapper below.

## `cch` — wrapper for interactive CC

`bin/cch` is a thin bash wrapper that catches exit code 129 (CC's SIGHUP handler exits with that code) and re-execs `claude --continue`. When you set `CCH_WRAPPER=1` (which `cch` does automatically), the Stop hook sends SIGHUP to the CC process after a successful splice. CC exits gracefully, the wrapper catches 129, re-execs with `--continue`, and CC picks up the freshly-compacted JSONL.

From the user's perspective: a brief TUI flash, then back in the same session with reduced context.

Install:
```
ln -s ~/Code/cc-background-compactor/bin/cch ~/.local/bin/cch
```

Then launch `cch` instead of `claude` whenever you want mid-session compaction to actually shrink the running context. Plain `claude` still works — the Stop hook only sends SIGHUP if `CCH_WRAPPER=1` is set, so there's no surprise behavior.

## Install

```
/plugin marketplace add rbrcurtis/cc-background-compactor
/plugin install cc-background-compactor
```

That's it. The Stop hook activates immediately. No settings.json edits required.

## Configuration

Edit `~/.config/cc-background-compactor/config.json` (created on first run if missing):

```json
{
  "enabled": true,
  "threshold": 0.7,
  "modelOverride": null,
  "contextWindow": null,
  "modelWindows": {},
  "maxExcerptChars": 120000,
  "ratio": 0.5
}
```

| Field | Default | What it does |
|-------|---------|--------------|
| `enabled` | `true` | Kill switch. |
| `threshold` | `0.7` | Fraction of context fill that triggers summarization (0.7 = 70%). |
| `modelOverride` | `null` | Pin a specific model for summarization. `null` = detect the parent session's model from the transcript and use the same one. |
| `modelWindows` | `{}` | Explicit per-model window overrides, e.g. `{"claude-opus-4-7": 1000000}` if you always run opus on the 1M variant. The JSONL strips the `[1m]` suffix, so the probe can't tell 1M variants from 200k base models — declaring it here is the durable fix. Highest priority; beats the probed cache. |
| `contextWindow` | `null` | Global fallback window in tokens for models not in `modelWindows` and not yet in the probed cache. `null` = auto-probe the model via `claude -p` and cache the result. |
| `maxExcerptChars` | `120000` | Cap on characters sent to the summarizer. Keeps the summarization call fast. |
| `ratio` | `0.5` | Fraction of the conversation to summarize. `0.5` = oldest half. |

**Window resolution priority:**
1. `modelWindows` explicit override from config
2. Session-captured variant suffix: if Claude Code's `SessionStart` hook captured a model identifier containing `[1m]` or `-1m`, force window to 1M. (The JSONL transcript strips this suffix, so without the capture we'd have no signal.)
3. Probed cache (`~/.config/cc-background-compactor/model-windows.json`, keyed by stripped name)
4. `contextWindow` config fallback
5. Name heuristic on the effective model

## Per-process disable

Set `CC_BACKGROUND_COMPACTOR_DISABLE=1` in the environment of a Claude Code process to make both hooks (`Stop` and `SessionStart`) no-op for that process. Accepted truthy values: `1`, `true`, `yes`, `on`.

Useful when you want the compactor globally installed but skipped for specific invocations — e.g., Agent SDK subprocesses spawned by another orchestrator that does its own compaction.

## Requirements

- Claude Code CLI with plugin support (`claude` on `PATH`)
- Node.js 20+

## What's NOT touched

- No changes to `~/.claude/settings.json` (plugin hooks work via `${CLAUDE_PLUGIN_ROOT}`)
- No statusLine modifications
- No shell prompt interference
- Only writes to: your transcript JSONL (atomic rename), `/tmp/cc-compact-*` (ephemeral), `~/.config/cc-background-compactor/config.json` (your opt-in config)

## Uninstall

```
/plugin uninstall cc-background-compactor
```

Any in-flight summarization finishes and writes to `/tmp` but is harmless — the Stop hook is gone so nothing will splice it. You can delete `/tmp/cc-compact-*` and `~/.config/cc-background-compactor/` to clean up.

## Debugging

Every Stop-hook invocation writes a heartbeat line to `/tmp/cc-compact-bg.log`:

```
2026-04-16T17:45:00.000Z heartbeat sid=abc-123 model=claude-opus-4-7 tokens=196906 window=1000000 source=modelWindows fraction=19.7% threshold=20%
```

`source` tells you which tier resolved the window: `modelWindows`, `cache`, `contextWindow`, or `heuristic`.

`tail -f /tmp/cc-compact-bg.log` to confirm the hook is firing and see why it is/isn't triggering.

## Build from source

```
pnpm install
pnpm build
```

The `dist/` bundles are committed, so end users don't need Node toolchain. Contributors do.

## License

MIT
