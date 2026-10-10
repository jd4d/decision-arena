// Pre-deploy secret scan: git-tracked files, untracked-but-not-ignored files (what a commit would add) and dist/.
// Fails (exit 1) on OpenRouter key patterns, Bearer literals, the real key value from ~/.pi/agent/auth.json or the
// environment (compared in memory, never printed), or local home-directory paths. Prints only file:line and the kind.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");

const secrets: string[] = [];
try {
  const k = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))?.openrouter?.key;
  if (typeof k === "string" && k.length >= 16) secrets.push(k);
} catch {}
if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length >= 16) secrets.push(process.env.OPENROUTER_API_KEY);
const home = homedir();

const PATTERNS: [string, RegExp][] = [
  ["OpenRouter key pattern (sk-or-)", /sk-or-[A-Za-z0-9_-]{8,}/],
  ["Bearer literal", /Bearer\s+(?!\$\{)[A-Za-z0-9._~+/=-]{16,}/],
  ["local home path", new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=[/\"'`\\s]|$)")],
];

const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const files = new Set<string>([...git(["ls-files"]), ...git(["ls-files", "--others", "--exclude-standard"])]);
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.add(relative(root, p));
  }
};
if (existsSync(join(root, "dist"))) walk(join(root, "dist"));
else console.warn("dist/ not found: run `pnpm build` first to scan the deploy bundle.");

const findings: string[] = [];
let scanned = 0;
for (const f of [...files].sort()) {
  const abs = join(root, f);
  if (!existsSync(abs) || !statSync(abs).isFile()) continue;
  const buf = readFileSync(abs);
  scanned++;
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const lineOf = (idx: number) => text.slice(0, idx).split("\n").length;
  for (const s of secrets) {
    const i = text.indexOf(s);
    if (i >= 0) findings.push(`${f}:${lineOf(i)}  the actual OpenRouter key`);
  }
  for (const [kind, re] of PATTERNS) {
    // The generated dist/<worker>/wrangler.json records the local config path for wrangler; it is not uploaded.
    if (kind === "local home path" && /^dist\/[^/]+\/wrangler\.json$/.test(f)) continue;
    lines.forEach((l, i) => { if (re.test(l)) findings.push(`${f}:${i + 1}  ${kind}`); });
  }
}

if (findings.length) {
  console.error(`deploy:check FAILED: ${findings.length} finding(s) in ${scanned} files (values not shown):`);
  for (const x of findings) console.error("  " + x);
  process.exit(1);
}
console.log(`deploy:check OK: ${scanned} files scanned (git-tracked, untracked non-ignored, dist/); no key patterns${secrets.length ? ", no copy of the real key" : " (no local key found to compare)"}, no local paths.`);
