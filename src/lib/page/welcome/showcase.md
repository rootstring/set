Every page in Set is a plain Markdown file underneath.

Type `/` on an empty line for the command menu, or start a line with the Markdown you already know: `#` for a heading, `-` for a list, `[ ]` for a to-do or `>` for a toggle.

## Text

**Bold**, *italic*, <u>underline</u>, ~~strikethrough~~, ==highlight==, `inline code` and [links](https://github.com/rootstring/set). Select some text to format it.

H<sub>2</sub>O and E = mc<sup>2</sup> work too, and so do footnotes.[^1]

## Lists

- Bullet lists
  - that nest
    - as deep as you like
- Drag the handle beside any block to move it

1. Numbered lists
2. that count for you

- [x] Open Set
- [ ] Write your first page
- [ ] Type `@` to add a date

## Toggles

<details open>
<summary>Click the arrow to fold this away</summary>

Here are toggle details.


</details>

## Quotes and callouts

> Simplicity is prerequisite for reliability.
>
> Edsger W. Dijkstra

> [!NOTE]
> Callouts are GitHub alerts, so they look the same on GitHub: `NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION`.

> [!TIP]
> Press {{quickSwitcher}} to jump to any page by its title or its contents.

> [!WARNING]
> Pages you delete go to Trash, and stay restorable until you empty it.

## Code

```ts
function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

## Equations

Dollar signs around LaTeX make an equation in a sentence, like $e^{i\pi} + 1 = 0$ or $\sqrt{a^2 + b^2}$. Two dollar signs on a line of their own, or Equation from the `/` menu, make a block:

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

Click an equation to change it: the source is edited in a popup that draws it as you type, and says what is wrong when it can't. A price like $5 stays a price.

## Tables

| Block | Markdown |
| --- | --- |
| Heading | `## Title` |
| To-do | `- [ ] Task` |
| Toggle | `<details>` |
| Callout | `> [!NOTE]` |
| Equation | `$$` |

## Dates

Type `@` to mention a date, like {{today}}, or a time, like {{tomorrowMorning}}.

## Links between pages

Wrap a page's title in double brackets to link to it, like [[Storage, Sync and Contexts]]. The page you link to lists this one under its backlinks.

A sub-page shows up as a block on its parent, the way this page does on the welcome page.

## Images

Paste or drop an image onto a page, or choose Image from the `/` menu. Drag its edge to resize it.

---

The line above is a divider: three dashes on a line of their own.

[^1]: Footnotes are numbered for you and collected at the bottom of the page.
