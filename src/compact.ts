import { readFile, unlink } from "node:fs/promises";
import { existsSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { applyCompaction, detectContextUsage } from "./jsonl.ts";
import { loadConfig } from "./config.ts";

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
    process.stderr.write(
      `[cc-compact] bad summary file, discarding: ${String(err)}\n`,
    );
    await unlink(sp).catch(() => {});
    return false;
  }

  if (prepared.transcriptPath !== currentTranscript) {
    process.stderr.write(`[cc-compact] summary transcript mismatch, discarding\n`);
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
    process.stderr.write(
      `[cc-compact] spliced: ${prepared.messagesCovered}/${prepared.messagesBefore} msgs, ${prepared.summaryChars} chars\n`,
    );
  } catch (err) {
    process.stderr.write(`[cc-compact] apply failed: ${String(err)}\n`);
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
): Promise<void> {
  const usage = await detectContextUsage(transcript, contextWindow);
  if (!usage) return;

  if (usage.fraction < threshold) return;

  const lp = lockPath(sid);
  if (existsSync(lp)) {
    try {
      const pid = parseInt(await readFile(lp, "utf8"), 10);
      if (!Number.isNaN(pid) && (await isPidRunning(pid))) return;
    } catch {
      /* treat as stale */
    }
  }

  if (existsSync(summaryPath(sid))) return;

  const here = dirname(fileURLToPath(import.meta.url));
  const summarizerPath = join(here, "summarize.js");

  const outFd = openSync("/tmp/cc-compact-bg.log", "a");

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

  const pct = (usage.fraction * 100).toFixed(1);
  process.stderr.write(
    `[cc-compact] triggered background summarize at ${pct}% (${usage.tokens}/${usage.window})\n`,
  );
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
  if (!cfg.enabled) return;

  await applyPending(sid, tp);
  await maybeTriggerSummarize(sid, tp, cfg.threshold, cfg.contextWindow);
}

main().catch((err) => {
  process.stderr.write(`[cc-compact] stop hook error: ${String(err)}\n`);
});
