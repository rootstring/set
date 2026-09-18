#!/usr/bin/env node
// Prepares `set-mcp` before the macOS bundler seals the app (`build.beforeBundleCommand`).
//
// Universal builds: `tauri build --target universal-apple-darwin` compiles both slices but `lipo`s
// only the app binary, so the bundler then asks for `universal-apple-darwin/release/set-mcp`,
// which nothing made. This script makes it from the two slices.
//
// Signing: the bundler signs `Contents/MacOS/set` first, which codesign resolves to the bundle
// itself, sealing an unsigned `set-mcp` beside it and failing. On arm64 the linker ad-hoc signs
// everything so it passed; a `lipo` output has no signature.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Tauri runs hooks from the frontend directory, so resolve from this file.
const root = fileURLToPath(new URL("..", import.meta.url));

if (process.platform !== "darwin") {
  process.exit(0);
}

const targetDir = join(root, "src-tauri", "target");
if (!existsSync(targetDir)) {
  process.exit(0);
}

// The universal app binary is the sign that this is a universal build; the slices are then
// guaranteed to exist because Tauri just built them.
const universalDir = join(targetDir, "universal-apple-darwin", "release");
const slices = ["aarch64-apple-darwin", "x86_64-apple-darwin"].map((triple) =>
  join(targetDir, triple, "release", "set-mcp"),
);
if (existsSync(join(universalDir, "set"))) {
  const missing = slices.filter((slice) => !existsSync(slice));
  if (missing.length > 0) {
    console.error(
      `::error::presign-mcp: universal build, but set-mcp slice missing: ${missing.join(", ")}`,
    );
    process.exit(1);
  }
  const universal = join(universalDir, "set-mcp");
  execFileSync("lipo", ["-create", "-output", universal, ...slices], {
    stdio: "inherit",
  });
  console.log(`presign-mcp: lipo'd ${universal}`);
}

// `target/release/` without `--target`, `target/<triple>/release/` with it (including the
// universal one made above, which is the copy the bundler ships).
const candidates = [join(targetDir, "release", "set-mcp")];
for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.endsWith("-apple-darwin")) {
    candidates.push(join(targetDir, entry.name, "release", "set-mcp"));
  }
}

let signed = 0;
for (const binary of candidates) {
  if (!existsSync(binary)) continue;
  // `--force`: the arm64 build already carries the linker's ad-hoc signature.
  execFileSync("codesign", ["--force", "--sign", "-", binary], { stdio: "inherit" });
  console.log(`presign-mcp: ad-hoc signed ${binary}`);
  signed += 1;
}

// Not a failure: a frontend-only rebuild reaches the bundler with nothing to sign. check-bundle.sh
// enforces that set-mcp shipped.
if (signed === 0) {
  console.log("presign-mcp: no set-mcp binary found to sign");
}
