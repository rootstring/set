#!/usr/bin/env node
// Writes N synthetic notes in the app's exact on-disk format (see src/lib/storage/serialize.ts,
// fs-store.ts) for benchmarking. Standalone on purpose: no app imports.
//   pnpm gen-notes --count 5000 --depth 4 --branching 8 --body-size 800 --out /tmp/set-bench
// Flags: --count (2000) --depth (4) --branching (8) --body-size (600) --out (./.bench-notes)
// --clean

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const defaults = {
    count: 2000,
    depth: 4,
    branching: 8,
    "body-size": 600,
    out: "./.bench-notes",
    clean: false,
  };
  const args = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key === "clean") {
      args.clean = true;
      continue;
    }
    if (!(key in defaults)) continue;
    const raw = argv[++i];
    args[key] = key === "out" ? raw : Number(raw);
  }
  return args;
}

/* Mirrors `sanitizeTitle` in fs-store.ts. */
function sanitizeTitle(title) {
  const cleaned = title
    .trim()
    .replace(/[/\\:*?"<>| -]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .slice(0, 120)
    .trim();
  return cleaned || "Untitled";
}

function freeBase(used, title) {
  const desired = sanitizeTitle(title);
  for (let i = 1; ; i++) {
    const base = i === 1 ? desired : `${desired} ${i}`;
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
  }
}

const LOREM =
  "The quick brown fox jumps over the lazy dog while the note taking app stays " +
  "responsive under load. Local first software keeps your data on your machine. ";

function makeBody(size, seed) {
  const parts = [`## Section ${seed}`, ""];
  let len = 0;
  let i = 0;
  while (len < size) {
    if (i % 4 === 3) {
      const item = `- item ${i}: ${LOREM.slice(0, 40)}`;
      parts.push(item);
      len += item.length;
    } else {
      const para = LOREM.repeat(1 + ((seed + i) % 3));
      parts.push(para, "");
      len += para.length;
    }
    i++;
  }
  return parts.join("\n");
}

/* Mirrors `pageToFile`. */
function fm(page) {
  const lines = [
    `id: ${JSON.stringify(page.id)}`,
    `title: ${JSON.stringify(page.title)}`,
    `parentId: ${JSON.stringify(page.parentId)}`,
    `createdAt: ${JSON.stringify(page.createdAt)}`,
    `updatedAt: ${JSON.stringify(page.updatedAt)}`,
  ];
  return `---\n${lines.join("\n")}\n---\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.out);
  const bodySize = args["body-size"];

  if (args.clean) await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  let created = 0;
  let clock = Date.UTC(2024, 0, 1);

  // Breadth-first so the tree stays balanced and hits `count` exactly.
  const queue = [{ dir: root, parentId: null, depth: 0 }];

  while (queue.length && created < args.count) {
    const { dir, parentId, depth } = queue.shift();
    const used = new Set();
    const childCount = Math.min(args.branching, args.count - created);

    for (let c = 0; c < childCount && created < args.count; c++) {
      created++;
      const id = crypto.randomUUID();
      const title = `Page ${created}`;
      const base = freeBase(used, title);
      const page = {
        id,
        title,
        parentId,
        createdAt: clock,
        updatedAt: clock,
      };
      clock += 1000;

      const file = join(dir, `${base}.md`);
      await writeFile(file, `${fm(page)}\n${makeBody(bodySize, created)}\n`);

      if (depth + 1 < args.depth && c % 2 === 0) {
        const childDir = join(dir, base);
        await mkdir(childDir, { recursive: true });
        queue.push({ dir: childDir, parentId: id, depth: depth + 1 });
      }
    }
  }

  console.log(`Wrote ${created} pages under ${root}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
