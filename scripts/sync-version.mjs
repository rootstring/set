#!/usr/bin/env node
// Propagates package.json's version to Cargo.toml, Cargo.lock and tauri.conf.json (the version the
// app and `latest.json` report; if it drifts, the updater offers nothing).
// Targeted text replacement, not parse-and-reserialise, so Prettier-formatted files stay untouched.
// Usage: node scripts/sync-version.mjs [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");

const read = (file) => readFileSync(join(root, file), "utf8");

const fail = (message) => {
  // `::error::` is a GitHub Actions annotation.
  console.error(`::error::${message}`);
  process.exit(1);
};

const version = JSON.parse(read("package.json")).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  fail(`package.json version is not a plain semver version: ${JSON.stringify(version)}`);
}

// Nothing is written until every edit has succeeded.
const edits = [];

// A bump that silently edits nothing is the failure this script exists to prevent.
const replaceOnce = (file, text, pattern, replacement, what) => {
  const matches = text.match(
    new RegExp(
      pattern,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    ),
  );
  if (!matches || matches.length !== 1) {
    fail(`${file}: expected exactly one ${what}, found ${matches ? matches.length : 0}`);
  }
  return text.replace(pattern, replacement);
};

// Scoped to `[package]`: `version = ` appears in every dependency table too.
{
  const file = "src-tauri/Cargo.toml";
  const text = read(file);
  const start = text.indexOf("[package]");
  if (start === -1) fail(`${file} has no [package] section`);
  const next = text.indexOf("\n[", start + 1);
  const end = next === -1 ? text.length : next;
  const section = replaceOnce(
    file,
    text.slice(start, end),
    /^version = "[^"]*"$/m,
    `version = "${version}"`,
    "version line in [package]",
  );
  edits.push([file, text.slice(0, start) + section + text.slice(end)]);
}

// Anchored on the three lines cargo writes together. `\r?\n`: Windows runners check out with
// autocrlf, so the lockfile can arrive with CRLF endings.
{
  const file = "src-tauri/Cargo.lock";
  const text = read(file);
  edits.push([
    file,
    replaceOnce(
      file,
      text,
      /(\[\[package\]\]\r?\nname = "set"\r?\nversion = ")[^"]*(")/,
      `$1${version}$2`,
      '[[package]] entry for "set"',
    ),
  ]);
}

// Anchored on the indent: `"version"` is not unique in this file.
{
  const file = "src-tauri/tauri.conf.json";
  let text = read(file);
  text = replaceOnce(
    file,
    text,
    /^ {2}"version": "[^"]*"/m,
    `  "version": "${version}"`,
    'top-level "version" key',
  );
  // Cheap insurance against a regex that matched something structural.
  try {
    JSON.parse(text);
  } catch (error) {
    fail(`${file} is no longer valid JSON after the version edit: ${error.message}`);
  }
  edits.push([file, text]);
}

const stale = edits.filter(([file, contents]) => read(file) !== contents);

if (check) {
  if (stale.length > 0) {
    fail(
      `version drift: package.json says ${version}, but ` +
        `${stale.map(([file]) => file).join(", ")} disagree. Run \`pnpm version:sync\`.`,
    );
  }
  console.log(`version ${version} is consistent across all four files`);
  process.exit(0);
}

for (const [file, contents] of stale) {
  writeFileSync(join(root, file), contents);
  console.log(`updated ${file}`);
}
console.log(`version ${version}`);
