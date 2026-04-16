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

async function main() {
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
