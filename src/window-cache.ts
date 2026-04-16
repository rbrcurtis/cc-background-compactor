import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const CACHE_PATH = join(
  homedir(),
  ".config",
  "cc-background-compactor",
  "model-windows.json",
);
const PROBE_LOCK = "/tmp/cc-background-compactor-probe.lock";

interface WindowCache {
  [model: string]: { window: number; probedAt: number };
}

export function loadCache(): WindowCache {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as WindowCache;
  } catch {
    return {};
  }
}

export function getCachedWindow(model: string): number | null {
  const cache = loadCache();
  const entry = cache[model];
  return entry ? entry.window : null;
}

export function saveWindow(model: string, window: number): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const cache = loadCache();
  cache[model] = { window, probedAt: Date.now() };
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

export function spawnProbeDetached(): void {
  if (existsSync(PROBE_LOCK)) {
    try {
      const pid = parseInt(readFileSync(PROBE_LOCK, "utf8"), 10);
      if (!Number.isNaN(pid)) {
        try {
          process.kill(pid, 0);
          return;
        } catch {
          /* stale */
        }
      }
    } catch {
      /* stale */
    }
  }

  const child = spawn(
    process.execPath,
    [new URL("./probe-window.js", import.meta.url).pathname],
    { detached: true, stdio: "ignore", env: process.env },
  );
  child.unref();
}
