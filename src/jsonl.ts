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
  /** Effective model used for window resolution — may be the session-captured identifier (with `[1m]`) or the JSONL model. */
  model: string | null;
  /** The raw model string from the transcript (always `[1m]`-stripped). */
  transcriptModel: string | null;
  windowSource: "modelWindows" | "cache" | "contextWindow" | "heuristic";
}

const DEFAULT_WINDOW = 200_000;

export function windowForModel(model: string | null): number {
  if (!model) return DEFAULT_WINDOW;
  const lc = model.toLowerCase();
  if (lc.includes("[1m]") || lc.includes("-1m")) return 1_000_000;
  return DEFAULT_WINDOW;
}

export interface WindowResolveOpts {
  /** Explicit per-model overrides from config; highest priority. */
  modelWindows?: Record<string, number> | null;
  /** Auto-probed cache lookup; beats fallbacks but loses to modelWindows. */
  cacheLookup?: (model: string) => number | null;
  /** Global fallback from config, used when no cache/override exists. */
  windowOverride?: number | null;
  /**
   * Model identifier captured at session start (may include `[1m]`).
   * Takes precedence over the JSONL model for window resolution since
   * the JSONL strips the `[1m]` suffix.
   */
  sessionModel?: string | null;
}

export async function detectContextUsage(
  jsonlPath: string,
  opts: WindowResolveOpts = {},
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

    const transcriptModel = typeof msg.model === "string" ? msg.model : null;
    // Session-captured model preserves the `[1m]` suffix the JSONL strips.
    const effectiveModel = opts.sessionModel ?? transcriptModel;

    // Priority:
    //   1. modelWindows explicit override (user declaration)
    //   2. session-captured variant suffix (`[1m]`/`-1m` → 1M), since this is
    //      an authoritative signal we can't get from the stripped JSONL name
    //   3. probed cache (keyed by stripped name)
    //   4. contextWindow fallback from config
    //   5. name heuristic on effective model
    //
    // We check modelWindows/cache against both effective and transcript model
    // so config entries keyed by either work.
    let window: number;
    let windowSource: ContextUsage["windowSource"];
    const explicit =
      (opts.modelWindows && effectiveModel ? opts.modelWindows[effectiveModel] : null) ??
      (opts.modelWindows && transcriptModel ? opts.modelWindows[transcriptModel] : null);
    const sessionHasExtendedSuffix =
      opts.sessionModel != null &&
      (opts.sessionModel.toLowerCase().includes("[1m]") ||
        opts.sessionModel.toLowerCase().includes("-1m"));
    const cached =
      (opts.cacheLookup && effectiveModel ? opts.cacheLookup(effectiveModel) : null) ??
      (opts.cacheLookup && transcriptModel ? opts.cacheLookup(transcriptModel) : null);

    if (explicit) {
      window = explicit;
      windowSource = "modelWindows";
    } else if (sessionHasExtendedSuffix) {
      window = 1_000_000;
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
      windowSource,
    };
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

/**
 * Session-level metadata that CC stamps on every entry. We harvest it from
 * the latest entry that carries it so synthetic boundary/summary entries
 * look native to CC's loader.
 */
interface SessionMetadata {
  version: string;
  cwd: string | null;
  gitBranch: string | null;
  userType: string;
  entrypoint: string;
  slug: string | null;
}

function extractSessionMetadata(lines: string[]): SessionMetadata {
  const meta: SessionMetadata = {
    version: "2.1.108",
    cwd: null,
    gitBranch: null,
    userType: "external",
    entrypoint: "cli",
    slug: null,
  };
  let haveVersion = false;
  let haveCwd = false;
  let haveBranch = false;
  let haveSlug = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (haveVersion && haveCwd && haveBranch && haveSlug) break;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
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

/** First UUID of a real conversation entry in the pre-compact range. */
function firstEntryUuid(lines: string[], endIdxInclusive: number): string | null {
  for (let i = 0; i <= endIdxInclusive; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "user" || obj.type === "assistant") {
        if (typeof obj.uuid === "string") return obj.uuid;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

export interface ApplyOpts {
  sessionId: string;
  jsonlPath: string;
  summary: string;
  lastOldLineIdx: number;
  /** Approx pre-compact token count for compactMetadata.preTokens. */
  preTokens?: number;
  /** Duration of the summarize step for compactMetadata.durationMs. */
  durationMs?: number;
  /** Trigger label (e.g. "background"). Defaults to "background". */
  trigger?: string;
}

export async function applyCompaction(opts: ApplyOpts): Promise<{
  outLines: number;
}> {
  const {
    sessionId,
    jsonlPath,
    summary,
    lastOldLineIdx,
    preTokens = 0,
    durationMs = 0,
    trigger = "background",
  } = opts;

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

  const meta = extractSessionMetadata(lines);
  const headUuid = firstEntryUuid(lines, lastOldLineIdx) ?? lastOldUuid;
  // ~4 chars per token is a coarse but reasonable English estimate.
  const postTokens = Math.max(1, Math.round(summary.length / 4));

  const summaryContent =
    `This session is being continued from a previous conversation that ran out of context. ` +
    `The summary below covers the earlier portion of the conversation.\n\n` +
    `Summary:\n${summary}`;

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
        tailUuid: lastOldUuid,
      },
      postTokens,
    },
    userType: meta.userType,
    entrypoint: meta.entrypoint,
    cwd: meta.cwd,
    sessionId,
    version: meta.version,
    gitBranch: meta.gitBranch,
    slug: meta.slug,
  });

  const summaryEntry = JSON.stringify({
    parentUuid: boundaryUuid,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: summaryContent,
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
    slug: meta.slug,
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
