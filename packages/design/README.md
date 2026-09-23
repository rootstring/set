# @rootstring/set-design

What makes something look like Set, for the app and for anything that shows a note outside it.

| File          | Is                                                                                   |
| ------------- | ------------------------------------------------------------------------------------ |
| `tokens.css`  | Colours, type, spacing and the reading column, light and dark (`data-theme` or OS)  |
| `fonts.css`   | Manrope and Roboto Serif, self-hosted from `fonts/` (OFL, licences alongside)        |
| `content.css` | A note's blocks, under `.ProseMirror` (the editor) or `.set-content` (published)     |

`content.css` styles the DOM that [`@rootstring/set-markdown`](../markdown)'s `renderHtml` emits.
Import all three, in that order, through a bundler that resolves the relative font URLs:

```css
@import "@rootstring/set-design/fonts.css";
@import "@rootstring/set-design/tokens.css";
@import "@rootstring/set-design/content.css";
```

Equations also need KaTeX's stylesheet (`katex/dist/katex.min.css`).
