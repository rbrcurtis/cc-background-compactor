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
  "maxExcerptChars": 120000,
  "ratio": 0.5
}
```

| Field | Default | What it does |
|-------|---------|--------------|
| `enabled` | `true` | Kill switch. |
| `threshold` | `0.7` | Fraction of context fill that triggers summarization (0.7 = 70%). |
| `modelOverride` | `null` | Pin a specific model for summarization. `null` = detect the parent session's model from the transcript and use the same one. |
| `contextWindow` | `null` | Fallback context window in tokens for models that aren't in the probed cache yet. `null` = auto-probe the model via `claude -p` and cache the result. Set to `1000000` if you use a 1M-context variant (`claude-opus-4-7[1m]`, `claude-sonnet-4-6[1m]`, etc.) — the JSONL strips the `[1m]` suffix so the probe can't distinguish 1M variants from their 200k base models. **Priority:** probed cache (`~/.config/cc-background-compactor/model-windows.json`) wins over this value, so setting it doesn't mask a known per-model window. Delete the cache entry if you need to re-probe. |
| `maxExcerptChars` | `120000` | Cap on characters sent to the summarizer. Keeps the summarization call fast. |
| `ratio` | `0.5` | Fraction of the conversation to summarize. `0.5` = oldest half. |

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
2026-04-16T17:45:00.000Z heartbeat sid=abc-123 model=claude-opus-4-7 tokens=196906 window=200000 fraction=98.5% threshold=70% cached=true cfgWindow=null
```

`tail -f /tmp/cc-compact-bg.log` to confirm the hook is firing and see why it is/isn't triggering.

## Build from source

```
pnpm install
pnpm build
```

The `dist/` bundles are committed, so end users don't need Node toolchain. Contributors do.

## License

MIT
