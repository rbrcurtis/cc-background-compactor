import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface CapturedSessionModel {
  sessionId: string;
  /** Full model identifier as Claude Code resolved it at session start. May include `[1m]`. */
  model: string;
  /** "startup" | "resume" | "clear" | other — echoes CC's SessionStart.source. */
  source?: string;
  capturedAt: number;
}

const STATE_DIR = join(
  homedir(),
  ".config",
  "cc-background-compactor",
  "session-models",
);

export function sessionModelPath(sid: string): string {
  return join(STATE_DIR, `${sid}.json`);
}

export function saveSessionModel(entry: CapturedSessionModel): void {
  if (!entry.sessionId || !entry.model) return;
  mkdirSync(STATE_DIR, { recursive: true });
  const p = sessionModelPath(entry.sessionId);
  writeFileSync(p, JSON.stringify(entry));
}

export function loadSessionModel(sid: string): CapturedSessionModel | null {
  const p = sessionModelPath(sid);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CapturedSessionModel>;
    if (!parsed.sessionId || !parsed.model) return null;
    return {
      sessionId: parsed.sessionId,
      model: parsed.model,
      source: parsed.source,
      capturedAt: parsed.capturedAt ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Claude Code user settings.json preserves the `[1m]` suffix in `"model"`
 * when the user explicitly configured it. Used as a fallback when the
 * SessionStart hook didn't fire (e.g. the plugin was installed mid-session).
 */
export function readSettingsModel(): string | null {
  const p = join(homedir(), ".claude", "settings.json");
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as { model?: unknown };
    return typeof s.model === "string" && s.model.length > 0 ? s.model : null;
  } catch {
    return null;
  }
}
