import { build } from "esbuild";
import { mkdirSync, chmodSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const entryPoints = ["src/compact.ts", "src/summarize.ts", "src/probe-window.ts"];

await build({
  entryPoints,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  outExtension: { ".js": ".js" },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  external: [],
  logLevel: "info",
});

for (const entry of entryPoints) {
  const out = entry.replace("src/", "dist/").replace(".ts", ".js");
  chmodSync(out, 0o755);
}
