import { readFile } from "node:fs/promises";
import { existsSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { detectContextUsage } from "./jsonl.ts";
import { loadConfig } from "./config.ts";
import { getCachedWindow, spawnProbeDetached } from "./window-cache.ts";
import { loadSessionModel, readSettingsModel } from "./session-model.ts";
import {
  BG_LOG,
  log,
  readStdin,
  envDisabled,
  spliceAndReload,
  summaryPath,
  lockPath,
} from "./hooks-shared.ts";

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveSessionModel(sid: string): { model: string | null; origin: string } {
  const captured = loadSessionModel(sid);
  if (captured?.model) return { model: captured.model, origin: "sessionStart" };
  const settings = readSettingsModel();
  if (settings) return { model: settings, origin: "settings" };
  return { model: null, origin: "none" };
}

async function maybeTriggerSummarize(
  sid: string,
  transcript: string,
  threshold: number,
  windowThresholds: Record<string, number>,
  contextWindow: number | null,
  modelWindows: Record<string, number>,
): Promise<void> {
  const { model: sessionModel, origin: modelOrigin } = resolveSessionModel(sid);

  const usage = await detectContextUsage(transcript, {
    modelWindows,
    cacheLookup: getCachedWindow,
    windowOverride: contextWindow,
    sessionModel,
  });
  if (!usage) {
    log(`heartbeat sid=${sid} no-usage-yet sessionModel=${sessionModel ?? "?"} (${modelOrigin})`);
    return;
  }

  // Resolution order: CC_BG_THRESHOLD env (per-process, e.g. orcd per-card)
  // > windowThresholds[exact window] > config.threshold (default).
  const envT = process.env.CC_BG_THRESHOLD;
  const envThreshold = envT && !Number.isNaN(parseFloat(envT)) ? parseFloat(envT) : null;
  const winOverride = windowThresholds[String(usage.window)];
  let effectiveThreshold: number;
  let thresholdSource: string;
  if (envThreshold !== null) {
    effectiveThreshold = envThreshold;
    thresholdSource = "env";
  } else if (typeof winOverride === "number") {
    effectiveThreshold = winOverride;
    thresholdSource = "windowThresholds";
  } else {
    effectiveThreshold = threshold;
    thresholdSource = "default";
  }

  const pct = (usage.fraction * 100).toFixed(1);
  log(
    `heartbeat sid=${sid} model=${usage.model ?? "?"} (${modelOrigin}) tokens=${usage.tokens} window=${usage.window} source=${usage.windowSource} fraction=${pct}% threshold=${(effectiveThreshold * 100).toFixed(0)}% (${thresholdSource})`,
  );

  // Only probe when we have no signal at all: no explicit override, no cache, no config fallback.
  if (usage.windowSource === "heuristic") {
    spawnProbeDetached(usage.model ?? undefined);
    log(`no window info for model=${usage.model ?? "?"}; probing in background`);
    return;
  }

  if (usage.fraction < effectiveThreshold) return;

  const lp = lockPath(sid);
  if (existsSync(lp)) {
    try {
      const pid = parseInt(await readFile(lp, "utf8"), 10);
      if (!Number.isNaN(pid) && (await isPidRunning(pid))) {
        log(`summarizer already running pid=${pid}, skipping`);
        return;
      }
    } catch {
      /* treat as stale */
    }
  }

  if (existsSync(summaryPath(sid))) {
    log(`pending summary already on disk, skipping trigger`);
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const summarizerPath = join(here, "summarize.js");

  const outFd = openSync(BG_LOG, "a");

  const child = spawn(
    "node",
    [summarizerPath, "--session-id", sid, "--transcript", transcript],
    {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: process.env,
    },
  );
  child.unref();
  closeSync(outFd);

  log(`triggered background summarize at ${pct}% (${usage.tokens}/${usage.window}, threshold=${(effectiveThreshold * 100).toFixed(0)}%)`);
}

async function main() {
  if (envDisabled()) {
    // Consume stdin so the caller doesn't see a broken pipe, then exit silently.
    await readStdin();
    return;
  }

  const raw = await readStdin();
  let input: StopHookInput = {};
  try {
    input = JSON.parse(raw) as StopHookInput;
  } catch {
    return;
  }

  const sid = input.session_id;
  const tp = input.transcript_path;
  if (!sid || !tp) {
    log(`hook=Stop sid=${sid ?? "?"} no-session-or-transcript`);
    return;
  }

  log(`hook=Stop sid=${sid} cch=${process.env.CCH_WRAPPER === "1" ? "1" : "0"}`);

  const cfg = loadConfig();
  if (!cfg.enabled) {
    log(`heartbeat sid=${sid} disabled`);
    return;
  }

  await spliceAndReload("Stop", sid, tp);
  await maybeTriggerSummarize(
    sid,
    tp,
    cfg.threshold,
    cfg.windowThresholds,
    cfg.contextWindow,
    cfg.modelWindows,
  );
}

main().catch((err) => {
  log(`stop hook error: ${String(err)}`);
});
