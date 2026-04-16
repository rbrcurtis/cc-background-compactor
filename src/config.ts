import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface CompactConfig {
  enabled: boolean;
  threshold: number;
  modelOverride: string | null;
  contextWindow: number | null;
  modelWindows: Record<string, number>;
  maxExcerptChars: number;
  ratio: number;
}

const DEFAULTS: CompactConfig = {
  enabled: true,
  threshold: 0.7,
  modelOverride: null,
  contextWindow: null,
  modelWindows: {},
  maxExcerptChars: 120_000,
  ratio: 0.5,
};

export const CONFIG_DIR = join(homedir(), ".config", "cc-background-compactor");
export const CONFIG_PATH =
  process.env.CC_BACKGROUND_COMPACTOR_CONFIG ?? join(CONFIG_DIR, "config.json");

export function loadConfig(): CompactConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<CompactConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: CompactConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
