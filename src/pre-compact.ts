import { log, readStdin, envDisabled, spliceAndReload } from "./hooks-shared.ts";

interface PreCompactInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  trigger?: string;
  custom_instructions?: string;
  hook_event_name?: string;
}

async function main() {
  if (envDisabled()) {
    await readStdin();
    return;
  }

  const raw = await readStdin();
  let input: PreCompactInput = {};
  try {
    input = JSON.parse(raw) as PreCompactInput;
  } catch {
    return;
  }

  const sid = input.session_id;
  const tp = input.transcript_path;
  if (!sid || !tp) {
    log(`hook=PreCompact sid=${sid ?? "?"} no-session-or-transcript`);
    return;
  }

  log(`hook=PreCompact sid=${sid} trigger=${input.trigger ?? "?"} cch=${process.env.CCH_WRAPPER === "1" ? "1" : "0"}`);

  // Try to splice our pre-prepared summary instead of letting CC's slow native compact run.
  // If we splice + SIGHUP, cch reloads with --continue and CC re-reads our compacted JSONL,
  // skipping the expensive native summarization. If no pending summary exists, CC's native
  // compact proceeds normally.
  const spliced = await spliceAndReload("PreCompact", sid, tp);
  if (!spliced) {
    log(`PreCompact sid=${sid} no pending summary — letting CC native compact proceed`);
  }
}

main().catch((err) => {
  log(`pre-compact hook error: ${String(err)}`);
});
