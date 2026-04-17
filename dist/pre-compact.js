#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/hooks-shared.ts
import { readFile as readFile2, unlink } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// src/jsonl.ts
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
function extractSessionMetadata(lines) {
  const meta = {
    version: "2.1.108",
    cwd: null,
    gitBranch: null,
    userType: "external",
    entrypoint: "cli",
    slug: null
  };
  let haveVersion = false;
  let haveCwd = false;
  let haveBranch = false;
  let haveSlug = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (haveVersion && haveCwd && haveBranch && haveSlug) break;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!haveVersion && typeof obj.version === "string") {
      meta.version = obj.version;
      haveVersion = true;
    }
    if (!haveCwd && typeof obj.cwd === "string") {
      meta.cwd = obj.cwd;
      haveCwd = true;
    }
    if (!haveBranch && typeof obj.gitBranch === "string") {
      meta.gitBranch = obj.gitBranch;
      haveBranch = true;
    }
    if (!haveSlug && typeof obj.slug === "string") {
      meta.slug = obj.slug;
      haveSlug = true;
    }
    if (typeof obj.userType === "string") meta.userType = obj.userType;
    if (typeof obj.entrypoint === "string") meta.entrypoint = obj.entrypoint;
  }
  return meta;
}
function firstEntryUuid(lines, endIdxInclusive) {
  for (let i = 0; i <= endIdxInclusive; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "user" || obj.type === "assistant") {
        if (typeof obj.uuid === "string") return obj.uuid;
      }
    } catch {
    }
  }
  return null;
}
async function applyCompaction(opts) {
  const {
    sessionId,
    jsonlPath,
    summary,
    lastOldLineIdx,
    preTokens = 0,
    durationMs = 0,
    trigger = "background"
  } = opts;
  const raw = await readFile(jsonlPath, "utf-8");
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  if (lastOldLineIdx >= lines.length) {
    throw new Error(
      `JSONL shrank since prepare: expected line ${lastOldLineIdx} but file has ${lines.length} lines`
    );
  }
  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const lastOldLine = lines[lastOldLineIdx];
  const lastOldObj = JSON.parse(lastOldLine);
  const lastOldUuid = lastOldObj.uuid;
  const meta = extractSessionMetadata(lines);
  const headUuid = firstEntryUuid(lines, lastOldLineIdx) ?? lastOldUuid;
  const postTokens = Math.max(1, Math.round(summary.length / 4));
  const summaryContent = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
${summary}`;
  const boundaryEntry = JSON.stringify({
    parentUuid: null,
    logicalParentUuid: lastOldUuid,
    isSidechain: false,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isMeta: false,
    timestamp: now,
    uuid: boundaryUuid,
    level: "info",
    compactMetadata: {
      trigger,
      preTokens,
      durationMs,
      preservedSegment: {
        headUuid,
        anchorUuid: summaryUuid,
        tailUuid: lastOldUuid
      },
      postTokens
    },
    userType: meta.userType,
    entrypoint: meta.entrypoint,
    cwd: meta.cwd,
    sessionId,
    version: meta.version,
    gitBranch: meta.gitBranch,
    slug: meta.slug
  });
  const summaryEntry = JSON.stringify({
    parentUuid: boundaryUuid,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: summaryContent
    },
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    uuid: summaryUuid,
    timestamp: now,
    userType: meta.userType,
    entrypoint: meta.entrypoint,
    cwd: meta.cwd,
    sessionId,
    version: meta.version,
    gitBranch: meta.gitBranch,
    slug: meta.slug
  });
  const outLines = lines.slice(0, lastOldLineIdx + 1);
  outLines.push(boundaryEntry);
  outLines.push(summaryEntry);
  const remaining = lines.slice(lastOldLineIdx + 1);
  let reparented = false;
  for (const line of remaining) {
    if (reparented) {
      outLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      outLines.push(line);
      continue;
    }
    try {
      const obj = JSON.parse(trimmed);
      obj.parentUuid = summaryUuid;
      outLines.push(JSON.stringify(obj));
      reparented = true;
    } catch {
      outLines.push(line);
    }
  }
  const tmpPath = jsonlPath + ".compact-tmp";
  await writeFile(tmpPath, outLines.join("\n") + "\n");
  await rename(tmpPath, jsonlPath);
  return { outLines: outLines.length };
}

// src/hooks-shared.ts
var BG_LOG = "/tmp/cc-compact-bg.log";
function log(line) {
  const stamp = (/* @__PURE__ */ new Date()).toISOString();
  try {
    appendFileSync(BG_LOG, `${stamp} ${line}
`);
  } catch {
  }
  process.stderr.write(`[cc-compact] ${line}
`);
}
function summaryPath(sid) {
  return join(tmpdir(), `cc-compact-summary-${sid}.json`);
}
async function readStdin() {
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
function envDisabled() {
  const v = process.env.CC_BACKGROUND_COMPACTOR_DISABLE;
  if (!v) return false;
  const lc = v.toLowerCase();
  return lc === "1" || lc === "true" || lc === "yes" || lc === "on";
}
async function applyPending(sid, currentTranscript) {
  const sp = summaryPath(sid);
  if (!existsSync(sp)) return false;
  let prepared;
  try {
    prepared = JSON.parse(await readFile2(sp, "utf8"));
  } catch (err) {
    log(`bad summary file, discarding: ${String(err)}`);
    await unlink(sp).catch(() => {
    });
    return false;
  }
  if (prepared.transcriptPath !== currentTranscript) {
    log(`summary transcript mismatch, discarding`);
    await unlink(sp).catch(() => {
    });
    return false;
  }
  try {
    const preTokens = prepared.excerptChars ? Math.max(1, Math.round(prepared.excerptChars / 4)) : 0;
    await applyCompaction({
      sessionId: prepared.sessionId,
      jsonlPath: prepared.transcriptPath,
      summary: prepared.summary,
      lastOldLineIdx: prepared.lastOldLineIdx,
      preTokens,
      durationMs: prepared.prepareDurationMs,
      trigger: "background"
    });
    log(
      `spliced: ${prepared.messagesCovered}/${prepared.messagesBefore} msgs, ${prepared.summaryChars} chars`
    );
  } catch (err) {
    log(`apply failed: ${String(err)}`);
    await unlink(sp).catch(() => {
    });
    return false;
  }
  await unlink(sp).catch(() => {
  });
  return true;
}
function sighupParentIfWrapped(reason) {
  if (process.env.CCH_WRAPPER !== "1") {
    log(`splice took effect, but CCH_WRAPPER not set \u2014 live session won't reload (${reason})`);
    return;
  }
  try {
    process.kill(process.ppid, "SIGHUP");
    log(`sent SIGHUP to cc (pid=${process.ppid}) for cch auto-reload (${reason})`);
  } catch (err) {
    log(`SIGHUP to cc failed (${reason}): ${String(err)}`);
  }
}
async function spliceAndReload(event, sid, transcriptPath) {
  const spliced = await applyPending(sid, transcriptPath);
  if (spliced) sighupParentIfWrapped(event);
  return spliced;
}

// src/pre-compact.ts
async function main() {
  if (envDisabled()) {
    await readStdin();
    return;
  }
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const sid = input.session_id;
  const tp = input.transcript_path;
  if (!sid || !tp) {
    log(`hook=PreCompact sid=${sid ?? "?"} no-session-or-transcript`);
    return;
  }
  log(`hook=PreCompact sid=${sid} trigger=${input.trigger ?? "?"} cch=${process.env.CCH_WRAPPER === "1" ? "1" : "0"}`);
  const spliced = await spliceAndReload("PreCompact", sid, tp);
  if (!spliced) {
    log(`PreCompact sid=${sid} no pending summary \u2014 letting CC native compact proceed`);
  }
}
main().catch((err) => {
  log(`pre-compact hook error: ${String(err)}`);
});
