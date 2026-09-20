# Development

## Setup

Requires Node 22 (see `.nvmrc`), pnpm and a Rust toolchain.

```bash
nvm use
corepack enable      # or: npm i -g pnpm
pnpm install
pnpm tauri dev       # desktop app
pnpm dev             # web build in the browser
```

On Linux, install Tauri's system libraries first. The list CI uses is in
[`.github/actions/linux-deps/action.yml`](../.github/actions/linux-deps/action.yml).

Dictation compiles whisper.cpp, which takes a few minutes. To skip it:

```bash
cd src-tauri && cargo build --no-default-features
```

Dictation then shows as unavailable.

## Tests

```bash
pnpm check                     # svelte-check
pnpm format:check              # Prettier (src/, e2e/)
pnpm test:unit                 # Vitest
pnpm build && pnpm test:e2e    # Playwright, against the production build
pnpm build && pnpm test:perf   # perf spec only
pnpm tauri build --no-bundle   # desktop build check
pnpm tauri:build:local         # installable bundle, no updater key needed

cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Playwright runs against `vite preview`, so run `pnpm build` first.

## Logs

The app writes one plain-text log wherever the OS keeps them. **Help → Show Log** opens the folder;
it holds the current `set.log` and one previous `set.log.1`, a megabyte each.

| macOS   | `~/Library/Logs/net.rootstring.set/`         |
| ------- | -------------------------------------------- |
| Linux   | `~/.local/state/net.rootstring.set/logs/`    |
| Windows | `%LOCALAPPDATA%\net.rootstring.set\logs\`    |

Each line is a timestamp, a level and an event with logfmt fields:

```
2026-09-18T14:02:11.482Z INFO  app.started version=0.0.1 os=macos arch=aarch64 dictation=true
2026-09-18T14:02:11.509Z INFO  notes.granted path="/Users/x/My Notes"
2026-09-18T14:02:11.604Z INFO  notes.scanned pages=412 ms=88
2026-09-18T14:05:31.220Z ERROR update.install_failed error="signature verification failed"
```

What goes in it: the lifecycle, the decisions the app made about the world, what took a long time,
and everything that failed — sync's own warnings and errors are mirrored in, and so are
whisper.cpp's. What never goes in it: page text, dictated text and search queries, so the file can
be attached to a bug report as it is.

Under `tauri dev` every line is also printed to the terminal. The crate's unit tests don't write to
it at all (`log::emit` refuses under `cfg(test)`, since they run against the real home directory);
`src-tauri/tests/app_log.rs` covers the real path with a home of its own.

The other two logs are features rather than diagnostics, and live with the app's state in the config
folder: `sync-log.jsonl` behind Settings → Sync, and `mcp-log.jsonl` behind Settings → Agent access.

## Large notes folder

`pnpm gen-notes` generates a notes folder in Set's format for testing scan, search and the sidebar at
scale:

```bash
pnpm gen-notes --count 5000 --depth 4 --branching 8 --body-size 800 --out /tmp/set-bench
```

Select the output folder in Settings → Notes. All flags are listed in the script header.

## Local bundles

`pnpm tauri:build:local` builds an installable bundle without release keys:

- It layers `src-tauri/tauri.local.conf.json` over the config, setting
  `bundle.createUpdaterArtifacts: false`, so `TAURI_SIGNING_PRIVATE_KEY` isn't needed.
- Without `APPLE_*` env vars, the macOS `.app`/`.dmg` is unsigned. Open it the first time with
  right-click → Open.
- The bundle has no `.sig`, so it can't be served as an update. Release bundles come from
  `release.yml`.

## Testing the updater

`SET_UPDATE_FEED` (read in `src-tauri/src/updates.rs`) overrides the update feed for one run:

```bash
# 1. Build a newer bundle, signed with the updater key.
#    On macOS the updater artifact is the .app.tar.gz next to its .sig.
npm version 0.9.0 --no-git-tag-version && node scripts/sync-version.mjs
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/set-updater.key)" pnpm tauri build

# 2. Serve it with a feed in the release.yml format (run from the repo root).
bundle=src-tauri/target/release/bundle/macos
mkdir -p /tmp/feed && cp "$bundle/Set.app.tar.gz" /tmp/feed/
cat > /tmp/feed/latest.json <<EOF
{
  "version": "0.9.0",
  "notes": "Testing the updater.",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$(cat "$bundle/Set.app.tar.gz.sig")",
      "url": "http://localhost:8080/Set.app.tar.gz"
    }
  }
}
EOF
(cd /tmp/feed && python3 -m http.server 8080) &

# 3. Restore the old version and run against the feed.
git checkout package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
SET_UPDATE_FEED=http://localhost:8080/latest.json pnpm tauri dev
```

- `tauri dev` covers everything up to the download. Debug builds accept a plain-http feed; release
  builds don't.
- To test the install, run an installed bundle at the old version (e.g. from
  `pnpm tauri:build:local`, in /Applications). Only the served bundle needs the updater signature.
  Serve the feed over https, or temporarily add `dangerousInsecureTransportProtocol: true` to the
  updater config in `tauri.conf.json`.
- None of this touches the live feed (`releases/latest/download/latest.json`). A pre-release bump
  (`preminor`, `prerelease`) tests the release pipeline but offers the update to no one, because
  GitHub's "latest" skips pre-releases.

## CI

| Workflow   | Checks                                                                               |
| ---------- | ------------------------------------------------------------------------------------ |
| `ci.yml`   | types, Prettier, version sync, rustfmt, Clippy, Rust unit tests, Linux desktop build |
| `e2e.yml`  | Playwright suite                                                                     |
| `perf.yml` | perf spec and Rust scan budget, with timings in the job summary                      |

- Pull requests and pushes build the desktop app on **Linux only**. Each build compiles iroh and
  whisper.cpp, and macOS runner minutes cost 10×.
- For macOS and Windows, run `ci.yml` manually (Actions → Checks → Run workflow), or `release.yml`
  with the `none` bump for real bundles on every platform.
- Platform-specific breakage therefore shows up at dispatch or release. Releases stay drafts until
  every check passes.
- The Linux job bundles a `.deb`, because `--no-bundle` skips the step that selects the app binary.

## Web

[writewithset.com](https://writewithset.com) is Cloudflare Pages building `main` with `pnpm build`,
but only when asked: the last job of `release.yml` POSTs the project's deploy hook once a mainline
release is published, by which time `main` holds the release commit. A pre-release (a version with
a `-`) deploys nothing, and neither does an ordinary push.

The hook URL is the `CLOUDFLARE_DEPLOY_HOOK` repository secret (Cloudflare: the Pages project →
Settings → Builds & deployments → Deploy hooks). Automatic production deployments are switched off
in the same place, or every push to `main` would still go live. To deploy by hand, POST the hook,
or retry a release's "Deploy the web app" job.

## App icons

The generated icons in `src-tauri/icons/` and `static/favicon.png` are committed; the source artwork
isn't. To regenerate (macOS only, needs `sips` and `iconutil`):

```bash
pnpm gen-icons path/to/icon.png path/to/icon-macos.png
```

| Source           | Generates                                                                    |
| ---------------- | ---------------------------------------------------------------------------- |
| `icon.png`       | Windows (`.ico`, `Square*Logo.png`), Linux/window PNGs, `static/favicon.png` |
| `icon-macos.png` | `src-tauri/icons/icon.icns`                                                  |

macOS has its own source because Apple's guidelines put the mark in an inset squircle with
transparent padding and a shadow. `gen-icons` builds the `.icns` from it and overwrites the one
`tauri icon` generates.
