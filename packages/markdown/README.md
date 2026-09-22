# @rootstring/set-markdown

Set's Markdown dialect, shared by the app's editor and anything that publishes a note.

- `setDialect(md)`: the markdown-it rules for what Set reads beyond CommonMark (highlights, strict
  linkify, footnotes, `[[wikilinks]]`, `> [!NOTE]` callouts, `$math$`). Tokens only.
- `renderHtml(markdown, options)` from `@rootstring/set-markdown/render`: a note as HTML, in the DOM
  the editor draws, for [`@rootstring/set-design`](../design)'s `content.css`.

Ships TypeScript source. Outside this workspace, have your bundler compile it (Vite:
`ssr.noExternal: ["@rootstring/set-markdown"]`). Install from git, pinned to a release tag:

```sh
pnpm add "github:rootstring/set#v0.0.3&path:packages/markdown"
```
