#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/probe-window.ts
import { spawn } from "node:child_process";
import { writeFileSync as writeFileSync2, unlinkSync, existsSync as existsSync2 } from "node:fs";

// src/window-cache.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
var CACHE_PATH = join(
  homedir(),
  ".config",
  "cc-background-compactor",
  "model-windows.json"
);
function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveWindow(model, window) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const cache = loadCache();
  cache[model] = { window, probedAt: Date.now() };
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// src/probe-window.ts
var LOCK = "/tmp/cc-background-compactor-probe.lock";
var LOG = "/tmp/cc-background-compactor-probe.log";
function log(msg) {
  try {
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`;
    const { appendFileSync } = __require("node:fs");
    appendFileSync(LOG, line);
  } catch {
  }
}
async function runProbe(targetModel) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json"];
    if (targetModel) args.push("--model", targetModel);
    const env = { ...process.env };
    if (targetModel) delete env.ANTHROPIC_MODEL;
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.stderr.on("data", (c) => {
      err += c.toString();
    });
    child.on("error", (e) => reject(e));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`));
        return;
      }
      resolve(out);
    });
    child.stdin.write("ack");
    child.stdin.end();
  });
}
async function main() {
  const targetModel = process.argv[2] ?? null;
  try {
    writeFileSync2(LOCK, String(process.pid));
    log(`probe starting pid=${process.pid} target=${targetModel ?? "env-default"}`);
    const out = await runProbe(targetModel);
    const parsed = JSON.parse(out);
    const usage = parsed.modelUsage ?? {};
    const written = [];
    for (const [model, entry] of Object.entries(usage)) {
      if (typeof entry.contextWindow !== "number") continue;
      saveWindow(model, entry.contextWindow);
      written.push(`${model}=${entry.contextWindow}`);
    }
    log(`probe done: ${written.join(", ")}`);
  } catch (err) {
    log(`probe error: ${String(err)}`);
  } finally {
    if (existsSync2(LOCK)) {
      try {
        unlinkSync(LOCK);
      } catch {
      }
    }
  }
}
main();
