#!/usr/bin/env node
/**
 * scripts/deploy.mjs
 *
 * Build the plugin and install it into the test vault, then nudge Obsidian to
 * hot-reload it — so verification (verification/phase1-check.md) is a one-shot
 * `node scripts/deploy.mjs` after each code change instead of a manual copy.
 *
 * What it does:
 *   1. `npm run build` (tsc typecheck + esbuild production bundle -> main.js).
 *   2. Copies main.js / manifest.json / styles.css into the vault's plugin dir.
 *   3. Bumps manifest.json's `version` patch number in the installed copy.
 *      Obsidian watches the plugin dir and reloads a plugin whose
 *      manifest.json mtime/version changes while the app is running — this is
 *      the reliable reload trigger (no manual "Reload plugin without saving"
 *      needed). The repo manifest is left untouched; only the installed copy
 *      is bumped, so it diverges harmlessly upward.
 *
 * Usage:
 *   node scripts/deploy.mjs [vault-plugin-dir]
 *
 * Defaults to:
 *   /Users/swantraces/Documents/Obsidian/USTC/.obsidian/plugins/obsidian-cdrawer
 */

import { execSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const DEFAULT_TARGET =
  "/Users/swantraces/Documents/Obsidian/USTC/.obsidian/plugins/obsidian-cdrawer";
const target = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_TARGET;

const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

function log(msg) {
  process.stdout.write(`• ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

// 1. Build.
log(`Building (npm run build) in ${REPO}…`);
try {
  execSync("npm run build", { cwd: REPO, stdio: "inherit" });
} catch {
  fail("build failed — fix the errors above before deploying");
}

// 2. Ensure target dir exists.
if (!existsSync(target)) {
  log(`Creating plugin dir: ${target}`);
  mkdirSync(target, { recursive: true });
}

// 3. Copy artifacts.
for (const name of ARTIFACTS) {
  const src = resolve(REPO, name);
  const dst = resolve(target, name);
  if (!existsSync(src)) fail(`missing build artifact: ${src}`);
  cpSync(src, dst, { preserveTimestamps: false });
  log(`copied ${name}`);
}

// 4. Bump the installed manifest's patch version to trigger Obsidian reload.
const manifestPath = resolve(target, "manifest.json");
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const [maj, min, patch] = String(manifest.version ?? "0.0.0")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  manifest.version = `${maj}.${min}.${patch + 1}`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  log(`bumped installed version -> ${manifest.version} (triggers Obsidian reload)`);
} catch (e) {
  fail(`could not bump installed manifest: ${e.message}`);
}

log("done. Reload the note in Obsidian to see changes.");
log("(If Obsidian doesn't pick it up, toggle the plugin off/on in Settings → Community plugins.)");
