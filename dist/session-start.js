#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/session-model.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var STATE_DIR = join(
  homedir(),
  ".config",
  "cc-background-compactor",
  "session-models"
);
function sessionModelPath(sid) {
  return join(STATE_DIR, `${sid}.json`);
}
function saveSessionModel(entry) {
  if (!entry.sessionId || !entry.model) return;
  mkdirSync(STATE_DIR, { recursive: true });
  const p = sessionModelPath(entry.sessionId);
  writeFileSync(p, JSON.stringify(entry));
}

// src/hooks-shared.ts
import { existsSync as existsSync2, appendFileSync } from "node:fs";
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

// src/session-start.ts
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
  const model = input.model;
  log(`hook=SessionStart sid=${sid ?? "?"} source=${input.source ?? "?"} model=${model ?? "?"} cch=${process.env.CCH_WRAPPER === "1" ? "1" : "0"}`);
  if (!sid || !model) return;
  saveSessionModel({
    sessionId: sid,
    model,
    source: input.source,
    capturedAt: Date.now()
  });
}
main().catch((err) => {
  log(`session-start hook error: ${String(err)}`);
});
