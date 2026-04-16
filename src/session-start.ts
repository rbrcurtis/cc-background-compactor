import { saveSessionModel } from "./session-model.ts";

interface SessionStartInput {
  session_id?: string;
  source?: string;
  model?: string;
  hook_event_name?: string;
  cwd?: string;
}

async function readStdin(): Promise<string> {
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

function envDisabled(): boolean {
  const v = process.env.CC_BACKGROUND_COMPACTOR_DISABLE;
  if (!v) return false;
  const lc = v.toLowerCase();
  return lc === "1" || lc === "true" || lc === "yes" || lc === "on";
}

async function main() {
  if (envDisabled()) {
    await readStdin();
    return;
  }

  const raw = await readStdin();
  let input: SessionStartInput = {};
  try {
    input = JSON.parse(raw) as SessionStartInput;
  } catch {
    return;
  }
  const sid = input.session_id;
  const model = input.model;
  if (!sid || !model) return;

  saveSessionModel({
    sessionId: sid,
    model,
    source: input.source,
    capturedAt: Date.now(),
  });
}

main().catch((err) => {
  process.stderr.write(`[cc-compact] session-start hook error: ${String(err)}\n`);
});
