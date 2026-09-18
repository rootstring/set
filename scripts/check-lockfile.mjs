#!/usr/bin/env node
// Catches Cargo.lock resolutions that only fail on Windows: crates like `wmi` declare `windows` and
// `windows-core` as independent ranges, so Cargo may pair mismatched release lines. The fix is
// `cargo update -p wmi`; this fails in milliseconds instead of ten minutes into the Windows build.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LOCKFILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src-tauri",
  "Cargo.lock",
);

/* Pairs that must share a release line wherever one crate depends on both. */
const MUST_MATCH = [["windows", "windows-core"]];

/* Cargo treats 0.x releases as incompatible across x. */
function releaseLine(version) {
  const [major, minor] = version.split(".");
  return major === "0" ? `0.${minor}` : major;
}

function parseLock(text) {
  const packages = [];
  for (const block of text.split("[[package]]").slice(1)) {
    const name = block.match(/^\s*name = "([^"]+)"/m)?.[1];
    const version = block.match(/^\s*version = "([^"]+)"/m)?.[1];
    if (!name || !version) continue;

    const deps = [];
    const list = block.match(/^dependencies = \[\n([\s\S]*?)^\]/m)?.[1];
    if (list) {
      for (const line of list.split("\n")) {
        const entry = line.match(/^\s*"([^"]+)"/)?.[1];
        if (!entry) continue;
        // `"name"` or `"name version"` when Cargo had to disambiguate.
        const [depName, depVersion] = entry.split(" ");
        deps.push({ name: depName, version: depVersion ?? null });
      }
    }
    packages.push({ name, version, deps });
  }
  return packages;
}

const packages = parseLock(readFileSync(LOCKFILE, "utf8"));
if (packages.length === 0) {
  console.error(`Could not read any packages from ${LOCKFILE}. Has its format changed?`);
  process.exit(1);
}

// A dep entry omits the version when unambiguous.
const versionsByName = new Map();
for (const pkg of packages) {
  if (!versionsByName.has(pkg.name)) versionsByName.set(pkg.name, []);
  versionsByName.get(pkg.name).push(pkg.version);
}

function resolve(dep) {
  if (dep.version) return dep.version;
  const known = versionsByName.get(dep.name);
  return known?.length === 1 ? known[0] : null;
}

const problems = [];
for (const pkg of packages) {
  for (const [a, b] of MUST_MATCH) {
    const depA = pkg.deps.find((d) => d.name === a);
    const depB = pkg.deps.find((d) => d.name === b);
    if (!depA || !depB) continue;

    const versionA = resolve(depA);
    const versionB = resolve(depB);
    // A lockfile we cannot read has not been checked.
    if (!versionA || !versionB) {
      problems.push(
        `${pkg.name} v${pkg.version}: could not resolve which ${!versionA ? a : b} it uses`,
      );
      continue;
    }
    if (releaseLine(versionA) !== releaseLine(versionB)) {
      problems.push(
        `${pkg.name} v${pkg.version} mixes release lines: ` +
          `${a} ${versionA} with ${b} ${versionB}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("Mismatched dependency resolution in src-tauri/Cargo.lock:\n");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    "\nThis compiles everywhere except Windows, where it fails inside the crate\n" +
      'above with "multiple different versions of crate `windows_core`".\n\n' +
      "Fix it by re-resolving just that crate, then commit the lockfile:\n" +
      `\n    cd src-tauri && cargo update -p ${problems[0].split(" ")[0]}\n`,
  );
  process.exit(1);
}

console.log(`Cargo.lock: ${packages.length} packages, no mismatched release lines.`);
