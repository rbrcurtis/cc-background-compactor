import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { saveWindow } from "./window-cache.ts";

const LOCK = "/tmp/cc-background-compactor-probe.lock";
const LOG = "/tmp/cc-background-compactor-probe.log";

function log(msg: string): void {
  try {
    const line = `${new Date().toISOString()} ${msg}\n`;
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(LOG, line);
  } catch {
    /* swallow */
  }
}

interface ModelUsageEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface ProbeResult {
  modelUsage?: Record<string, ModelUsageEntry>;
}

async function runProbe(targetModel: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json"];
    if (targetModel) args.push("--model", targetModel);
    const env = { ...process.env };
    if (targetModel) delete env.ANTHROPIC_MODEL;
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
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
    writeFileSync(LOCK, String(process.pid));
    log(`probe starting pid=${process.pid} target=${targetModel ?? "env-default"}`);

    const out = await runProbe(targetModel);
    const parsed = JSON.parse(out) as ProbeResult;
    const usage = parsed.modelUsage ?? {};

    const written: string[] = [];
    for (const [model, entry] of Object.entries(usage)) {
      if (typeof entry.contextWindow !== "number") continue;
      saveWindow(model, entry.contextWindow);
      written.push(`${model}=${entry.contextWindow}`);
    }
    log(`probe done: ${written.join(", ")}`);
  } catch (err) {
    log(`probe error: ${String(err)}`);
  } finally {
    if (existsSync(LOCK)) {
      try {
        unlinkSync(LOCK);
      } catch {
        /* swallow */
      }
    }
  }
}

main();
