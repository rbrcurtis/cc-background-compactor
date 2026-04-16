import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface IndexedMessage {
  lineIndex: number;
  role: "user" | "assistant";
  text: string;
  isToolResult: boolean;
  isToolUse: boolean;
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const blocks = content as Array<Record<string, unknown>>;
  const parts: string[] = [];

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
        for (const tb of c as Array<Record<string, unknown>>) {
          if (tb.type === "text" && typeof tb.text === "string") {
            parts.push(`[tool result: ${(tb.text as string).slice(0, 500)}]`);
          }
        }
      }
    }
  }

  return parts.join("\n");
}

export function parseLines(lines: string[]): {
  lastBoundaryLine: number;
  messages: IndexedMessage[];
} {
  let lastBoundaryLine = -1;
  const messages: IndexedMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj.type === "system" && obj.subtype === "compact_boundary") {
      lastBoundaryLine = i;
      messages.length = 0;
      continue;
    }

    if (obj.type !== "user" && obj.type !== "assistant") continue;

    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const role = message.role as string;
    if (role !== "user" && role !== "assistant") continue;

    const content = message.content;
    const text = extractText(content);
    if (!text.trim()) continue;

    const blocks = Array.isArray(content)
      ? (content as Array<Record<string, unknown>>)
      : [];
    const isToolResult = blocks.some((b) => b.type === "tool_result");
    const isToolUse = blocks.some((b) => b.type === "tool_use");

    messages.push({
      lineIndex: i,
      role: role as "user" | "assistant",
      text,
      isToolResult,
      isToolUse,
    });
  }

  return { lastBoundaryLine, messages };
}

export function buildExcerpt(msgs: IndexedMessage[], maxChars: number): string {
  const parts: string[] = [];
  let total = 0;

  for (const m of msgs) {
    const text = m.text.length > 3000 ? m.text.slice(0, 3000) : m.text;
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

export function computeCutoff(
  messages: IndexedMessage[],
  ratio: number,
): number {
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

export interface ContextUsage {
  tokens: number;
  window: number;
  fraction: number;
  model: string | null;
}

const DEFAULT_WINDOW = 200_000;

function windowForModel(model: string | null): number {
  if (!model) return DEFAULT_WINDOW;
  const lc = model.toLowerCase();
  if (lc.includes("[1m]") || lc.includes("-1m")) return 1_000_000;
  return DEFAULT_WINDOW;
}

export async function detectContextUsage(
  jsonlPath: string,
  windowOverride?: number | null,
  cacheLookup?: (model: string) => number | null,
): Promise<ContextUsage | null> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(jsonlPath, "utf-8").catch(() => "");
  if (!raw) return null;
  const lines = raw.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const input = Number(usage.input_tokens ?? 0);
    const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
    const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
    const tokens = input + cacheRead + cacheCreate;
    if (!tokens) continue;

    const model = typeof msg.model === "string" ? msg.model : null;
    // Priority: per-model probed cache > config override > name-based default.
    // The cache wins so a global `contextWindow` in config never masks a known
    // per-model window (e.g. 1M set in config wouldn't silence a 200k opus).
    const cached = cacheLookup && model ? cacheLookup(model) : null;
    const window = cached ?? windowOverride ?? windowForModel(model);
    return { tokens, window, fraction: tokens / window, model };
  }
  return null;
}

export function detectParentModel(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.model === "string" && msg.model.length > 0) {
      return msg.model;
    }
  }
  return null;
}

function findVersion(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.version === "string") return obj.version;
    } catch {
      /* skip */
    }
  }
  return "2.1.108";
}

export interface ApplyOpts {
  sessionId: string;
  jsonlPath: string;
  summary: string;
  lastOldLineIdx: number;
}

export async function applyCompaction(opts: ApplyOpts): Promise<{
  outLines: number;
}> {
  const { sessionId, jsonlPath, summary, lastOldLineIdx } = opts;

  const raw = await readFile(jsonlPath, "utf-8");
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  if (lastOldLineIdx >= lines.length) {
    throw new Error(
      `JSONL shrank since prepare: expected line ${lastOldLineIdx} but file has ${lines.length} lines`,
    );
  }

  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const now = new Date().toISOString();

  const lastOldLine = lines[lastOldLineIdx];
  const lastOldObj = JSON.parse(lastOldLine) as Record<string, unknown>;
  const lastOldUuid = lastOldObj.uuid as string;

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
  });

  const summaryEntry = JSON.stringify({
    parentUuid: boundaryUuid,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: `[Context Summary — the following summarizes the earlier part of this conversation]\n\n${summary}`,
    },
    uuid: summaryUuid,
    timestamp: now,
    sessionId,
    version: findVersion(lines),
  });

  const outLines: string[] = lines.slice(0, lastOldLineIdx + 1);
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
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
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
