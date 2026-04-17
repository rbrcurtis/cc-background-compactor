import { log, readStdin, envDisabled, spliceAndReload } from "./hooks-shared.ts";

interface UserPromptSubmitInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  hook_event_name?: string;
}

async function main() {
  if (envDisabled()) {
    await readStdin();
    return;
  }

  const raw = await readStdin();
  let input: UserPromptSubmitInput = {};
  try {
    input = JSON.parse(raw) as UserPromptSubmitInput;
  } catch {
    return;
  }

  const sid = input.session_id;
  const tp = input.transcript_path;
  if (!sid || !tp) {
    log(`hook=UserPromptSubmit sid=${sid ?? "?"} no-session-or-transcript`);
    return;
  }

  const promptLen = input.prompt?.length ?? 0;
  log(`hook=UserPromptSubmit sid=${sid} promptChars=${promptLen} cch=${process.env.CCH_WRAPPER === "1" ? "1" : "0"}`);

  await spliceAndReload("UserPromptSubmit", sid, tp);
}

main().catch((err) => {
  log(`turn-start hook error: ${String(err)}`);
});
