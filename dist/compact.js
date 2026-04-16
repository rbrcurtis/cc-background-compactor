#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/compact.ts
import { readFile as readFile2, unlink } from "node:fs/promises";
import { existsSync as existsSync4, openSync, closeSync, appendFileSync } from "node:fs";
import { spawn as spawn2 } from "node:child_process";
import { join as join4 } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname as dirname4 } from "node:path";

// src/jsonl.ts
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
var DEFAULT_WINDOW = 2e5;
function windowForModel(model) {
  if (!model) return DEFAULT_WINDOW;
  const lc = model.toLowerCase();
  if (lc.includes("[1m]") || lc.includes("-1m")) return 1e6;
  return DEFAULT_WINDOW;
}
async function detectContextUsage(jsonlPath, opts = {}) {
  const { readFile: readFile3 } = await import("node:fs/promises");
  const raw = await readFile3(jsonlPath, "utf-8").catch(() => "");
  if (!raw) return null;
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const msg = obj.message;
    if (!msg) continue;
    const usage = msg.usage;
    if (!usage) continue;
    const input = Number(usage.input_tokens ?? 0);
    const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
    const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
    const tokens = input + cacheRead + cacheCreate;
    if (!tokens) continue;
    const transcriptModel = typeof msg.model === "string" ? msg.model : null;
    const effectiveModel = opts.sessionModel ?? transcriptModel;
    let window;
    let windowSource;
    const explicit = (opts.modelWindows && effectiveModel ? opts.modelWindows[effectiveModel] : null) ?? (opts.modelWindows && transcriptModel ? opts.modelWindows[transcriptModel] : null);
    const sessionHasExtendedSuffix = opts.sessionModel != null && (opts.sessionModel.toLowerCase().includes("[1m]") || opts.sessionModel.toLowerCase().includes("-1m"));
    const cached = (opts.cacheLookup && effectiveModel ? opts.cacheLookup(effectiveModel) : null) ?? (opts.cacheLookup && transcriptModel ? opts.cacheLookup(transcriptModel) : null);
    if (explicit) {
      window = explicit;
      windowSource = "modelWindows";
    } else if (sessionHasExtendedSuffix) {
      window = 1e6;
      windowSource = "heuristic";
    } else if (cached) {
      window = cached;
      windowSource = "cache";
    } else if (opts.windowOverride) {
      window = opts.windowOverride;
      windowSource = "contextWindow";
    } else {
      window = windowForModel(effectiveModel);
      windowSource = "heuristic";
    }
    return {
      tokens,
      window,
      fraction: tokens / window,
      model: effectiveModel,
      transcriptModel,
      windowSource
    };
  }
  return null;
}
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

// src/config.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
var DEFAULTS = {
  enabled: true,
  threshold: 0.7,
  modelOverride: null,
  contextWindow: null,
  modelWindows: {},
  maxExcerptChars: 12e4,
  ratio: 0.5
};
var CONFIG_DIR = join(homedir(), ".config", "cc-background-compactor");
var CONFIG_PATH = process.env.CC_BACKGROUND_COMPACTOR_CONFIG ?? join(CONFIG_DIR, "config.json");
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

// src/window-cache.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { spawn } from "node:child_process";
import { homedir as homedir2 } from "node:os";
import { join as join2, dirname as dirname2 } from "node:path";
var CACHE_PATH = join2(
  homedir2(),
  ".config",
  "cc-background-compactor",
  "model-windows.json"
);
var PROBE_LOCK = "/tmp/cc-background-compactor-probe.lock";
function loadCache() {
  if (!existsSync2(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync2(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function getCachedWindow(model) {
  const cache = loadCache();
  const entry = cache[model];
  return entry ? entry.window : null;
}
function spawnProbeDetached(targetModel) {
  if (existsSync2(PROBE_LOCK)) {
    try {
      const pid = parseInt(readFileSync2(PROBE_LOCK, "utf8"), 10);
      if (!Number.isNaN(pid)) {
        try {
          process.kill(pid, 0);
          return;
        } catch {
        }
      }
    } catch {
    }
  }
  const args = [new URL("./probe-window.js", import.meta.url).pathname];
  if (targetModel) args.push(targetModel);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
}

// src/session-model.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
var STATE_DIR = join3(
  homedir3(),
  ".config",
  "cc-background-compactor",
  "session-models"
);
function sessionModelPath(sid) {
  return join3(STATE_DIR, `${sid}.json`);
}
function loadSessionModel(sid) {
  const p = sessionModelPath(sid);
  if (!existsSync3(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync3(p, "utf8"));
    if (!parsed.sessionId || !parsed.model) return null;
    return {
      sessionId: parsed.sessionId,
      model: parsed.model,
      source: parsed.source,
      capturedAt: parsed.capturedAt ?? 0
    };
  } catch {
    return null;
  }
}
function readSettingsModel() {
  const p = join3(homedir3(), ".claude", "settings.json");
  if (!existsSync3(p)) return null;
  try {
    const s = JSON.parse(readFileSync3(p, "utf8"));
    return typeof s.model === "string" && s.model.length > 0 ? s.model : null;
  } catch {
    return null;
  }
}

// src/compact.ts
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
  return join4(tmpdir(), `cc-compact-summary-${sid}.json`);
}
function lockPath(sid) {
  return join4(tmpdir(), `cc-compact-lock-${sid}`);
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
async function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function applyPending(sid, currentTranscript) {
  const sp = summaryPath(sid);
  if (!existsSync4(sp)) return false;
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
function resolveSessionModel(sid) {
  const captured = loadSessionModel(sid);
  if (captured?.model) return { model: captured.model, origin: "sessionStart" };
  const settings = readSettingsModel();
  if (settings) return { model: settings, origin: "settings" };
  return { model: null, origin: "none" };
}
async function maybeTriggerSummarize(sid, transcript, threshold, contextWindow, modelWindows) {
  const { model: sessionModel, origin: modelOrigin } = resolveSessionModel(sid);
  const usage = await detectContextUsage(transcript, {
    modelWindows,
    cacheLookup: getCachedWindow,
    windowOverride: contextWindow,
    sessionModel
  });
  if (!usage) {
    log(`heartbeat sid=${sid} no-usage-yet sessionModel=${sessionModel ?? "?"} (${modelOrigin})`);
    return;
  }
  const pct = (usage.fraction * 100).toFixed(1);
  log(
    `heartbeat sid=${sid} model=${usage.model ?? "?"} (${modelOrigin}) tokens=${usage.tokens} window=${usage.window} source=${usage.windowSource} fraction=${pct}% threshold=${(threshold * 100).toFixed(0)}%`
  );
  if (usage.windowSource === "heuristic") {
    spawnProbeDetached(usage.model ?? void 0);
    log(`no window info for model=${usage.model ?? "?"}; probing in background`);
    return;
  }
  if (usage.fraction < threshold) return;
  const lp = lockPath(sid);
  if (existsSync4(lp)) {
    try {
      const pid = parseInt(await readFile2(lp, "utf8"), 10);
      if (!Number.isNaN(pid) && await isPidRunning(pid)) {
        log(`summarizer already running pid=${pid}, skipping`);
        return;
      }
    } catch {
    }
  }
  if (existsSync4(summaryPath(sid))) {
    log(`pending summary already on disk, skipping trigger`);
    return;
  }
  const here = dirname4(fileURLToPath(import.meta.url));
  const summarizerPath = join4(here, "summarize.js");
  const outFd = openSync(BG_LOG, "a");
  const child = spawn2(
    "node",
    [summarizerPath, "--session-id", sid, "--transcript", transcript],
    {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: process.env
    }
  );
  child.unref();
  closeSync(outFd);
  log(`triggered background summarize at ${pct}% (${usage.tokens}/${usage.window})`);
}
async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw);
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
    cfg.modelWindows
  );
}
main().catch((err) => {
  log(`stop hook error: ${String(err)}`);
});
