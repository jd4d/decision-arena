// Writes .dev.vars (local Worker secrets) with OPENROUTER_API_KEY from ~/.pi/agent/auth.json (openrouter.key).
// Keeps any other lines already in .dev.vars (e.g. MAX_CONCURRENT=1 for queue tests). Never prints the key.
// Usage: node scripts/dev-vars.ts [KEY=VALUE ...]   (extra assignments are set/overwritten too)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const file = join(root, ".dev.vars");

try {
  execFileSync("git", ["check-ignore", "-q", ".dev.vars"], { cwd: root });
} catch {
  console.error("Refusing to write .dev.vars: it is not gitignored.");
  process.exit(1);
}

let key: string | undefined;
try {
  key = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))?.openrouter?.key;
} catch {}
if (!key || typeof key !== "string") {
  console.error("No openrouter.key in ~/.pi/agent/auth.json.");
  process.exit(1);
}

const vars = new Map<string, string>();
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) vars.set(m[1], m[2]);
  }
}
vars.set("OPENROUTER_API_KEY", key);
for (const a of process.argv.slice(2)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(a);
  if (!m || m[1] === "OPENROUTER_API_KEY") { console.error(`Ignoring argument (expected KEY=VALUE): ${a.split("=")[0]}`); continue; }
  if (m[2] === "") vars.delete(m[1]);
  else vars.set(m[1], m[2]);
}
writeFileSync(file, [...vars].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
console.log(`Wrote .dev.vars (${[...vars.keys()].join(", ")}). Restart \`pnpm dev\` to pick it up.`);
