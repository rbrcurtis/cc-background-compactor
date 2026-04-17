import { saveSessionModel } from "./session-model.ts";
import { log, readStdin, envDisabled } from "./hooks-shared.ts";

interface SessionStartInput {
  session_id?: string;
  source?: string;
  model?: string;
  hook_event_name?: string;
  cwd?: string;
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
  log(`hook=SessionStart sid=${sid ?? "?"} source=${input.source ?? "?"} model=${model ?? "?"} cch=${process.env.CCH_WRAPPER === "1" ? "1" : "0"}`);
  if (!sid || !model) return;

  saveSessionModel({
    sessionId: sid,
    model,
    source: input.source,
    capturedAt: Date.now(),
  });
}

main().catch((err) => {
  log(`session-start hook error: ${String(err)}`);
});
