#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/arg@5.0.2/node_modules/arg/index.js
var require_arg = __commonJS({
  "node_modules/.pnpm/arg@5.0.2/node_modules/arg/index.js"(exports, module) {
    var flagSymbol = Symbol("arg flag");
    var ArgError = class _ArgError extends Error {
      constructor(msg, code) {
        super(msg);
        this.name = "ArgError";
        this.code = code;
        Object.setPrototypeOf(this, _ArgError.prototype);
      }
    };
    function arg2(opts, {
      argv = process.argv.slice(2),
      permissive = false,
      stopAtPositional = false
    } = {}) {
      if (!opts) {
        throw new ArgError(
          "argument specification object is required",
          "ARG_CONFIG_NO_SPEC"
        );
      }
      const result = { _: [] };
      const aliases = {};
      const handlers = {};
      for (const key of Object.keys(opts)) {
        if (!key) {
          throw new ArgError(
            "argument key cannot be an empty string",
            "ARG_CONFIG_EMPTY_KEY"
          );
        }
        if (key[0] !== "-") {
          throw new ArgError(
            `argument key must start with '-' but found: '${key}'`,
            "ARG_CONFIG_NONOPT_KEY"
          );
        }
        if (key.length === 1) {
          throw new ArgError(
            `argument key must have a name; singular '-' keys are not allowed: ${key}`,
            "ARG_CONFIG_NONAME_KEY"
          );
        }
        if (typeof opts[key] === "string") {
          aliases[key] = opts[key];
          continue;
        }
        let type = opts[key];
        let isFlag = false;
        if (Array.isArray(type) && type.length === 1 && typeof type[0] === "function") {
          const [fn] = type;
          type = (value, name, prev = []) => {
            prev.push(fn(value, name, prev[prev.length - 1]));
            return prev;
          };
          isFlag = fn === Boolean || fn[flagSymbol] === true;
        } else if (typeof type === "function") {
          isFlag = type === Boolean || type[flagSymbol] === true;
        } else {
          throw new ArgError(
            `type missing or not a function or valid array type: ${key}`,
            "ARG_CONFIG_VAD_TYPE"
          );
        }
        if (key[1] !== "-" && key.length > 2) {
          throw new ArgError(
            `short argument keys (with a single hyphen) must have only one character: ${key}`,
            "ARG_CONFIG_SHORTOPT_TOOLONG"
          );
        }
        handlers[key] = [type, isFlag];
      }
      for (let i = 0, len = argv.length; i < len; i++) {
        const wholeArg = argv[i];
        if (stopAtPositional && result._.length > 0) {
          result._ = result._.concat(argv.slice(i));
          break;
        }
        if (wholeArg === "--") {
          result._ = result._.concat(argv.slice(i + 1));
          break;
        }
        if (wholeArg.length > 1 && wholeArg[0] === "-") {
          const separatedArguments = wholeArg[1] === "-" || wholeArg.length === 2 ? [wholeArg] : wholeArg.slice(1).split("").map((a) => `-${a}`);
          for (let j = 0; j < separatedArguments.length; j++) {
            const arg3 = separatedArguments[j];
            const [originalArgName, argStr] = arg3[1] === "-" ? arg3.split(/=(.*)/, 2) : [arg3, void 0];
            let argName = originalArgName;
            while (argName in aliases) {
              argName = aliases[argName];
            }
            if (!(argName in handlers)) {
              if (permissive) {
                result._.push(arg3);
                continue;
              } else {
                throw new ArgError(
                  `unknown or unexpected option: ${originalArgName}`,
                  "ARG_UNKNOWN_OPTION"
                );
              }
            }
            const [type, isFlag] = handlers[argName];
            if (!isFlag && j + 1 < separatedArguments.length) {
              throw new ArgError(
                `option requires argument (but was followed by another short argument): ${originalArgName}`,
                "ARG_MISSING_REQUIRED_SHORTARG"
              );
            }
            if (isFlag) {
              result[argName] = type(true, argName, result[argName]);
            } else if (argStr === void 0) {
              if (argv.length < i + 2 || argv[i + 1].length > 1 && argv[i + 1][0] === "-" && !(argv[i + 1].match(/^-?\d*(\.(?=\d))?\d*$/) && (type === Number || // eslint-disable-next-line no-undef
              typeof BigInt !== "undefined" && type === BigInt))) {
                const extended = originalArgName === argName ? "" : ` (alias for ${argName})`;
                throw new ArgError(
                  `option requires argument: ${originalArgName}${extended}`,
                  "ARG_MISSING_REQUIRED_LONGARG"
                );
              }
              result[argName] = type(argv[i + 1], argName, result[argName]);
              ++i;
            } else {
              result[argName] = type(argStr, argName, result[argName]);
            }
          }
        } else {
          result._.push(wholeArg);
        }
      }
      return result;
    }
    arg2.flag = (fn) => {
      fn[flagSymbol] = true;
      return fn;
    };
    arg2.COUNT = arg2.flag((v, name, existingCount) => (existingCount || 0) + 1);
    arg2.ArgError = ArgError;
    module.exports = arg2;
  }
});

// src/summarize.ts
var import_arg = __toESM(require_arg(), 1);
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
import { spawn } from "node:child_process";
import { join as join2 } from "node:path";
import { tmpdir } from "node:os";

// src/jsonl.ts
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks = content;
  const parts = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
    if (b.type === "tool_use" && typeof b.name === "string") {
      parts.push(`[tool: ${b.name}]`);
    }
    if (b.type === "tool_result") {
      const c = b.content;
      if (typeof c === "string") {
        parts.push(`[tool result: ${c.slice(0, 500)}]`);
      } else if (Array.isArray(c)) {
        for (const tb of c) {
          if (tb.type === "text" && typeof tb.text === "string") {
            parts.push(`[tool result: ${tb.text.slice(0, 500)}]`);
          }
        }
      }
    }
  }
  return parts.join("\n");
}
function parseLines(lines) {
  let lastBoundaryLine = -1;
  const messages = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "system" && obj.subtype === "compact_boundary") {
      lastBoundaryLine = i;
      messages.length = 0;
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const message = obj.message;
    if (!message) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = message.content;
    const text = extractText(content);
    if (!text.trim()) continue;
    const blocks = Array.isArray(content) ? content : [];
    const isToolResult = blocks.some((b) => b.type === "tool_result");
    const isToolUse = blocks.some((b) => b.type === "tool_use");
    messages.push({
      lineIndex: i,
      role,
      text,
      isToolResult,
      isToolUse
    });
  }
  return { lastBoundaryLine, messages };
}
function buildExcerpt(msgs, maxChars) {
  const parts = [];
  let total = 0;
  for (const m of msgs) {
    const text = m.text.length > 3e3 ? m.text.slice(0, 3e3) : m.text;
    const line = `[${m.role}]: ${text}`;
    if (total + line.length > maxChars) {
      const remaining = maxChars - total;
      if (remaining > 100) {
        parts.push(line.slice(0, remaining) + "\n... (truncated)");
      }
      break;
    }
    parts.push(line);
    total += line.length;
  }
  return parts.join("\n\n");
}
function computeCutoff(messages, ratio) {
  let cutoff = Math.floor(messages.length * ratio);
  if (cutoff < 2) return cutoff;
  while (cutoff > 2) {
    const firstKept = messages[cutoff];
    const lastSummarized = messages[cutoff - 1];
    if (firstKept.isToolResult || lastSummarized.isToolUse) {
      cutoff--;
    } else {
      break;
    }
  }
  return cutoff;
}
function detectParentModel(lines) {
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
    if (msg && typeof msg.model === "string" && msg.model.length > 0) {
      return msg.model;
    }
  }
  return null;
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
  maxExcerptChars: 12e4,
  ratio: 0.5
};
var CONFIG_DIR = join(homedir(), ".config", "cc-background-compactor");
var CONFIG_PATH = join(CONFIG_DIR, "config.json");
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

// src/summarize.ts
var SUMMARIZE_PROMPT = `You are a conversation summarizer. Do not use any tools. Do not read any files. Respond with ONLY the summary text.

Given the following conversation between a user and an AI assistant, produce a concise summary that preserves:

1. Key decisions made and their rationale
2. Important technical details, file paths, and code patterns discovered
3. Current state of the work \u2014 what's done, what's pending
4. Any constraints, preferences, or requirements the user stated
5. Context needed for the conversation to continue productively

Format the summary as a structured document with clear sections. Be thorough but concise \u2014 aim for roughly 2000-4000 words. The summary will replace the original messages in the context window, so anything not captured here is lost.

Here is the conversation to summarize:

`;
function lockPath(sid) {
  return join2(tmpdir(), `cc-compact-lock-${sid}`);
}
function summaryPath(sid) {
  return join2(tmpdir(), `cc-compact-summary-${sid}.json`);
}
async function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function acquireLock(sid) {
  const lp = lockPath(sid);
  if (existsSync2(lp)) {
    try {
      const pid = parseInt(await readFile(lp, "utf8"), 10);
      if (!Number.isNaN(pid) && await isPidRunning(pid)) {
        return false;
      }
    } catch {
    }
  }
  await writeFile(lp, String(process.pid));
  return true;
}
async function releaseLock(sid) {
  try {
    await unlink(lockPath(sid));
  } catch {
  }
}
async function runClaudeP(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text"];
    if (model) {
      args.splice(1, 0, "--model", model);
    }
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `claude -p exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
          )
        );
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
async function main() {
  const args = (0, import_arg.default)({
    "--session-id": String,
    "--transcript": String
  });
  const sid = args["--session-id"];
  const tp = args["--transcript"];
  if (!sid || !tp) {
    process.stderr.write(
      "usage: summarize.js --session-id <id> --transcript <path>\n"
    );
    process.exit(2);
  }
  const cfg = loadConfig();
  const got = await acquireLock(sid);
  if (!got) {
    process.stderr.write(`[cc-compact] lock held for ${sid}, skipping
`);
    process.exit(0);
  }
  try {
    const raw = await readFile(tp, "utf-8");
    const lines = raw.split("\n");
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    const { messages } = parseLines(lines);
    const cutoff = computeCutoff(messages, cfg.ratio);
    if (cutoff < 2) {
      process.stderr.write(
        `[cc-compact] too few messages to compact (${messages.length}), skipping
`
      );
      return;
    }
    const oldestHalf = messages.slice(0, cutoff);
    const excerpt = buildExcerpt(oldestHalf, cfg.maxExcerptChars);
    const lastOldLineIdx = oldestHalf[oldestHalf.length - 1].lineIndex;
    const model = cfg.modelOverride ?? detectParentModel(lines) ?? process.env.ANTHROPIC_MODEL ?? null;
    process.stderr.write(
      `[cc-compact] summarizing ${cutoff}/${messages.length} messages, ${excerpt.length} chars, model=${model ?? "(claude default)"}
`
    );
    const t0 = Date.now();
    const summary = await runClaudeP(SUMMARIZE_PROMPT + excerpt, model);
    const durMs = Date.now() - t0;
    if (!summary) {
      throw new Error("claude -p returned empty summary");
    }
    await writeFile(
      summaryPath(sid),
      JSON.stringify({
        sessionId: sid,
        transcriptPath: tp,
        summary,
        lastOldLineIdx,
        messagesBefore: messages.length,
        messagesCovered: cutoff,
        summaryChars: summary.length,
        prepareDurationMs: durMs,
        timestamp: Date.now()
      })
    );
    process.stderr.write(
      `[cc-compact] summary ready: ${summary.length} chars in ${durMs}ms
`
    );
  } finally {
    await releaseLock(sid);
  }
}
main().catch((err) => {
  process.stderr.write(`[cc-compact] summarizer error: ${String(err)}
`);
  process.exit(1);
});
