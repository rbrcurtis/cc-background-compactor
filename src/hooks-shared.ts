import { readFile, unlink } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyCompaction } from "./jsonl.ts";

export const BG_LOG = "/tmp/cc-compact-bg.log";

export function log(line: string): void {
  const stamp = new Date().toISOString();
  try {
    appendFileSync(BG_LOG, `${stamp} ${line}\n`);
  } catch {
    /* best-effort */
  }
  process.stderr.write(`[cc-compact] ${line}\n`);
}

export interface PreparedSummary {
  sessionId: string;
  transcriptPath: string;
  summary: string;
  lastOldLineIdx: number;
  messagesBefore: number;
  messagesCovered: number;
  summaryChars: number;
  excerptChars?: number;
  prepareDurationMs: number;
  timestamp: number;
}

export function summaryPath(sid: string): string {
  return join(tmpdir(), `cc-compact-summary-${sid}.json`);
}

export function lockPath(sid: string): string {
  return join(tmpdir(), `cc-compact-lock-${sid}`);
}

export async function readStdin(): Promise<string> {
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

export function envDisabled(): boolean {
  const v = process.env.CC_BACKGROUND_COMPACTOR_DISABLE;
  if (!v) return false;
  const lc = v.toLowerCase();
  return lc === "1" || lc === "true" || lc === "yes" || lc === "on";
}

export async function applyPending(
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
    const preTokens = prepared.excerptChars
      ? Math.max(1, Math.round(prepared.excerptChars / 4))
      : 0;
    await applyCompaction({
      sessionId: prepared.sessionId,
      jsonlPath: prepared.transcriptPath,
      summary: prepared.summary,
      lastOldLineIdx: prepared.lastOldLineIdx,
      preTokens,
      durationMs: prepared.prepareDurationMs,
      trigger: "background",
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

export function sighupParentIfWrapped(reason: string): void {
  if (process.env.CCH_WRAPPER !== "1") {
    log(`splice took effect, but CCH_WRAPPER not set — live session won't reload (${reason})`);
    return;
  }
  try {
    process.kill(process.ppid, "SIGHUP");
    log(`sent SIGHUP to cc (pid=${process.ppid}) for cch auto-reload (${reason})`);
  } catch (err) {
    log(`SIGHUP to cc failed (${reason}): ${String(err)}`);
  }
}

export async function spliceAndReload(
  event: string,
  sid: string,
  transcriptPath: string,
): Promise<boolean> {
  const spliced = await applyPending(sid, transcriptPath);
  if (spliced) sighupParentIfWrapped(event);
  return spliced;
}
