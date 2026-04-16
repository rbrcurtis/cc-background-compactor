import { readFile, unlink } from "node:fs/promises";
import { existsSync, openSync, closeSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { applyCompaction, detectContextUsage } from "./jsonl.ts";
import { loadConfig } from "./config.ts";
import { getCachedWindow, spawnProbeDetached } from "./window-cache.ts";

const BG_LOG = "/tmp/cc-compact-bg.log";

function log(line: string): void {
  const stamp = new Date().toISOString();
  try {
    appendFileSync(BG_LOG, `${stamp} ${line}\n`);
  } catch {
    /* best-effort */
  }
  process.stderr.write(`[cc-compact] ${line}\n`);
}

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

interface PreparedSummary {
  sessionId: string;
  transcriptPath: string;
  summary: string;
  lastOldLineIdx: number;
  messagesBefore: number;
  messagesCovered: number;
  summaryChars: number;
  prepareDurationMs: number;
  timestamp: number;
}

function summaryPath(sid: string): string {
  return join(tmpdir(), `cc-compact-summary-${sid}.json`);
}

function lockPath(sid: string): string {
  return join(tmpdir(), `cc-compact-lock-${sid}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function applyPending(
  sid: string,
  currentTranscript: string,
): Promise<boolean> {
  const sp = summaryPath(sid);
  if (!existsSync(sp)) return false;

  let prepared: PreparedSummary;
  try {
    prepared = JSON.parse(await readFile(sp, "utf8")) as PreparedSummary;
  } catch (err) {
    log(`bad summary file, discarding: ${String(err)}`);
    await unlink(sp).catch(() => {});
    return false;
  }

  if (prepared.transcriptPath !== currentTranscript) {
    log(`summary transcript mismatch, discarding`);
    await unlink(sp).catch(() => {});
    return false;
  }

  try {
    await applyCompaction({
      sessionId: prepared.sessionId,
      jsonlPath: prepared.transcriptPath,
      summary: prepared.summary,
      lastOldLineIdx: prepared.lastOldLineIdx,
    });
    log(
      `spliced: ${prepared.messagesCovered}/${prepared.messagesBefore} msgs, ${prepared.summaryChars} chars`,
    );
  } catch (err) {
    log(`apply failed: ${String(err)}`);
    await unlink(sp).catch(() => {});
    return false;
  }

  await unlink(sp).catch(() => {});
  return true;
}

async function maybeTriggerSummarize(
  sid: string,
  transcript: string,
  threshold: number,
  contextWindow: number | null,
  modelWindows: Record<string, number>,
): Promise<void> {
  const usage = await detectContextUsage(transcript, {
    modelWindows,
    cacheLookup: getCachedWindow,
    windowOverride: contextWindow,
  });
  if (!usage) {
    log(`heartbeat sid=${sid} no-usage-yet`);
    return;
  }

  const pct = (usage.fraction * 100).toFixed(1);
  log(
    `heartbeat sid=${sid} model=${usage.model ?? "?"} tokens=${usage.tokens} window=${usage.window} source=${usage.windowSource} fraction=${pct}% threshold=${(threshold * 100).toFixed(0)}%`,
  );

  // Only probe when we have no signal at all: no explicit override, no cache, no config fallback.
  if (usage.windowSource === "heuristic") {
    spawnProbeDetached(usage.model ?? undefined);
    log(`no window info for model=${usage.model ?? "?"}; probing in background`);
    return;
  }

  if (usage.fraction < threshold) return;

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

  log(`triggered background summarize at ${pct}% (${usage.tokens}/${usage.window})`);
}

async function main() {
  const raw = await readStdin();
  let input: StopHookInput = {};
  try {
    input = JSON.parse(raw) as StopHookInput;
  } catch {
    return;
  }

  const sid = input.session_id;
  const tp = input.transcript_path;
  if (!sid || !tp) return;

  const cfg = loadConfig();
  if (!cfg.enabled) {
    log(`heartbeat sid=${sid} disabled`);
    return;
  }

  await applyPending(sid, tp);
  await maybeTriggerSummarize(
    sid,
    tp,
    cfg.threshold,
    cfg.contextWindow,
    cfg.modelWindows,
  );
}

main().catch((err) => {
  log(`stop hook error: ${String(err)}`);
});
