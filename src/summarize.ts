import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import arg from "arg";
import {
  parseLines,
  buildExcerpt,
  computeCutoff,
  detectParentModel,
  type IndexedMessage,
} from "./jsonl.ts";
import { loadConfig } from "./config.ts";

const SUMMARIZE_PROMPT = `You are a conversation summarizer. Do not use any tools. Do not read any files. Respond with ONLY the summary text.

Given the following conversation between a user and an AI assistant, produce a concise summary that preserves:

1. Key decisions made and their rationale
2. Important technical details, file paths, and code patterns discovered
3. Current state of the work — what's done, what's pending
4. Any constraints, preferences, or requirements the user stated
5. Context needed for the conversation to continue productively

Format the summary as a structured document with clear sections. Be thorough but concise — aim for roughly 2000-4000 words. The summary will replace the original messages in the context window, so anything not captured here is lost.

Here is the conversation to summarize:

`;

function lockPath(sid: string): string {
  return join(tmpdir(), `cc-compact-lock-${sid}`);
}

function summaryPath(sid: string): string {
  return join(tmpdir(), `cc-compact-summary-${sid}.json`);
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(sid: string): Promise<boolean> {
  const lp = lockPath(sid);
  if (existsSync(lp)) {
    try {
      const pid = parseInt(await readFile(lp, "utf8"), 10);
      if (!Number.isNaN(pid) && (await isPidRunning(pid))) {
        return false;
      }
    } catch {
      /* fall through — treat as stale */
    }
  }
  await writeFile(lp, String(process.pid));
  return true;
}

async function releaseLock(sid: string): Promise<void> {
  try {
    await unlink(lockPath(sid));
  } catch {
    /* swallow */
  }
}

async function runClaudeP(
  prompt: string,
  model: string | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text"];
    if (model) {
      args.splice(1, 0, "--model", model);
    }
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
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
            `claude -p exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
          ),
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
  const args = arg({
    "--session-id": String,
    "--transcript": String,
  });

  const sid = args["--session-id"];
  const tp = args["--transcript"];

  if (!sid || !tp) {
    process.stderr.write(
      "usage: summarize.js --session-id <id> --transcript <path>\n",
    );
    process.exit(2);
  }

  const cfg = loadConfig();

  const got = await acquireLock(sid);
  if (!got) {
    process.stderr.write(`[cc-compact] lock held for ${sid}, skipping\n`);
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
        `[cc-compact] too few messages to compact (${messages.length}), skipping\n`,
      );
      return;
    }

    const oldestHalf: IndexedMessage[] = messages.slice(0, cutoff);
    const excerpt = buildExcerpt(oldestHalf, cfg.maxExcerptChars);
    const lastOldLineIdx = oldestHalf[oldestHalf.length - 1].lineIndex;

    const model =
      cfg.modelOverride ??
      detectParentModel(lines) ??
      process.env.ANTHROPIC_MODEL ??
      null;

    process.stderr.write(
      `[cc-compact] summarizing ${cutoff}/${messages.length} messages, ${excerpt.length} chars, model=${model ?? "(claude default)"}\n`,
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
        timestamp: Date.now(),
      }),
    );

    process.stderr.write(
      `[cc-compact] summary ready: ${summary.length} chars in ${durMs}ms\n`,
    );
  } finally {
    await releaseLock(sid);
  }
}

main().catch((err) => {
  process.stderr.write(`[cc-compact] summarizer error: ${String(err)}\n`);
  process.exit(1);
});
