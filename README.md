# Commutative Diagram Editor for Obsidian

An Obsidian plugin to **author and render commutative diagrams** on a fixed grid
— the same interaction model as [tikzcd.yichuanshen.de](https://tikzcd.yichuanshen.de).
Trigger "Insert commutative diagram," build the diagram on a grid of cells (type
LaTeX labels, drag to draw arrows), and click away to commit. The note gets a
**static, inline-rendered diagram** styled to match Obsidian's native
`$$\begin{CD}…\end{CD}$$` — so a reader can't tell which mechanism produced it.
Click the rendered diagram later to reopen the same grid editor, pre-filled.

Diagrams are stored as a `cd` fenced code block containing a small JSON model, so
they live in plain text in your vault, diff cleanly, and survive sync/undo. You
can also **export to [tikz-cd](https://ctan.org/pkg/tikz-cd)** or plain AMS `CD`
for use in a paper, and **import** either back into an editable diagram.

> **Status:** v1.0. Display (rendering existing diagrams) works on desktop and
> mobile. The grid **editor** is desktop-only for now — see
> [Mobile](#mobile).

---

## Installation

### From the community plugin browser (once accepted)
Settings → Community plugins → Browse → search "Commutative Diagram Editor".

### Manual / from source
1. Clone this repo.
2. `npm install && npm run build` (produces `main.js`).
3. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<vault>/.obsidian/plugins/obsidian-cd-editor/`.
4. Enable the plugin under Settings → Community plugins.

For local development, `node scripts/deploy.mjs` builds and installs into a
configurable test vault and bumps the installed version so Obsidian hot-reloads
it. `npm test` runs the unit/integration suite; `npm run build` typechecks and
bundles.

---

## How it works

```
Insert (ribbon / command palette / right-click)  ──►  Floating grid editor
                                                         (grid of cells,
                                                          drag to draw arrows)
            click outside / Escape  ◄──  commits ──┘
                  │
                  ▼
        ```cd fenced block (JSON model)  ──►  static SVG, styled like \begin{CD}
                                                  click  ──►  reopen the editor
```

- **Edit mode** — a transient floating grid overlay (not a Modal) anchored at the
  cursor. Exists only while open.
- **Display mode** — a static SVG that lives permanently in the note, rendered to
  match native `CD` blocks in font size, arrow weight, and spacing, in any theme.

Both modes share the **same** renderer, so what you see while editing is exactly
what you get after committing.

---

## Creating a diagram

Open the editor in any of three ways:

- the **ribbon icon** (grid glyph),
- the command palette → **"Insert commutative diagram"** (bindable to a hotkey),
- right-click in the editor → **"Insert commutative diagram"**.

Then in the grid:

- **Click a cell** to type a LaTeX label (e.g. `A`, `X_{n}`, `\Omega`). A live
  MathJax preview appears as you type.
- **Drag from one cell to another** to draw an arrow. (A press that releases in
  place just edits the label, so the two gestures don't fight.)
- **Click an arrow** to open its properties popover: label, label position
  (left/right/above/below), head style, line style, bidirectional toggle, delete.
- **+ row / + col** add rows/columns; hover a row or column header for a small
  **–** to remove it (destructive removes — those that would delete a label or
  arrow endpoint — are hidden, so you can't nuke content by accident).
- **Commit** by clicking outside the overlay or pressing **Escape**. The only way
  to **discard** is the explicit **Discard** button — a stray Escape never loses
  work. An entirely empty draft commits nothing (no empty block is written).

While editing, a **live preview** beneath the grid shows the rendered diagram —
the same SVG that will be committed.

### Clicking a rendered diagram to re-edit

By default a rendered diagram shows a small **Edit** button on hover (so reading
and scrolling don't open the editor by accident). Settings → "Click to edit
diagrams" toggles immediate click-anywhere-to-edit for power users.

---

## The `cd` block format

A committed diagram is stored as a `cd` fenced code block containing
pretty-printed JSON:

````
```cd
{
  "version": 1,
  "rows": 2,
  "cols": 3,
  "cells": [
    { "row": 0, "col": 0, "label": "A" },
    { "row": 0, "col": 2, "label": "B" },
    { "row": 1, "col": 0, "label": "C" },
    { "row": 1, "col": 2, "label": "D" }
  ],
  "arrows": [
    { "id": "a1", "from": { "row": 0, "col": 0 }, "to": { "row": 0, "col": 2 }, "label": "f" },
    { "id": "a2", "from": { "row": 1, "col": 0 }, "to": { "row": 1, "col": 2 }, "label": "g" },
    { "id": "a3", "from": { "row": 0, "col": 0 }, "to": { "row": 1, "col": 0 } },
    { "id": "a4", "from": { "row": 0, "col": 2 }, "to": { "row": 1, "col": 2 }, "head": "hook" }
  ]
}
```
````

### Fields

| Field | Meaning |
| --- | --- |
| `rows`, `cols` | Grid extent. Cells/arrows reference positions inside it. |
| `cells` | Sparse: only labelled cells are listed (empty cells are omitted). `label` is raw LaTeX; empty string = unoccupied. |
| `arrows[].from` / `to` | `{ row, col }` endpoints. Arrows may connect **any** two cells, not just neighbors (diagonal / skip arrows are drawn as straight lines, like the reference editor — no auto-routing). |
| `arrows[].label` | Raw LaTeX arrow label, optional. |
| `arrows[].labelPosition` | `"left"` (default) \| `"right"` \| `"above"` \| `"below"`, relative to the arrow's direction of travel. |
| `arrows[].head` | `"default"` \| `"epi"` (↠) \| `"hook"` (↪) \| `"mapsto"` (↦) \| `"none"`. |
| `arrows[].lineStyle` | `"solid"` (default) \| `"dashed"` \| `"dotted"`. |
| `arrows[].bidirectional` | `true` renders a double-headed arrow (`<->`), for isomorphisms/equivalences. |

Multiple arrows between the same pair of cells are offset symmetrically. The
schema is additive-only across versions (new fields are optional), so existing
blocks keep working as the plugin evolves.

---

## Import / export

Diagrams are meant to leave Obsidian and end up in a paper, so import/export is
first-class. All four are available both as **commands** (with the cursor inside
a block) and as **buttons in the editor's chrome** (Import / Export popovers).

### Export to tikz-cd

Command palette → **"Export diagram as tikz-cd"** inserts a `tikzcd` block below
the diagram. The pullback square above exports to:

```latex
\begin{tikzcd}
  A \arrow[rr, "f"] \arrow[d] &  & B \arrow[d, hook] \\
  C \arrow[rr, "g"] &  & D
\end{tikzcd}
```

which compiles unmodified in a document with `\usepackage{tikz-cd}`. Head/line
vocabulary maps 1:1: `epi→two heads`, `hook→hook`, `mapsto→mapsto`,
`none→no head`, `bidirectional→leftrightarrow`, `dashed`, `dotted`; a right-side
label gets the `swap` marker.

### Export to AMS CD

Command palette → **"Export diagram as AMS CD"** emits a `$$\begin{CD}…\end{CD}$$`
block. This is only offered when the diagram is **CD-expressible** — every arrow
connects orthogonally-adjacent cells with at most one label, no styled heads, no
bidirectional, solid lines. Otherwise you get a notice explaining why (e.g.
"contains a diagonal or skipped arrow — export as tikz-cd instead"), so you never
get lossy output silently.

### Import from tikz-cd

Command palette → **"Import tikz-cd block as editable diagram"** (with the cursor
in a ` ```tikzcd ` block) parses the tikz-cd subset and replaces it with an
editable `cd` block. Supports both modern bracket form `\arrow[r, "f", two heads]`
and legacy `\arrow{r}{f}`, `"g"'` / `"g" swap` label placement, multi-step (`rr`)
and diagonal (`dr`/`ul`) directions. Unknown options (bend, color, phantom, …)
are ignored rather than failing, so a real block you paste in mostly imports.

### Import from AMS CD

Paste a `\begin{CD}…\end{CD}` block into the editor's **Import** popover (format:
"AMS CD") to replace the draft with its parsed model. All four arrow directions
(`@>>> @<<< @VVV @AAA`) convert, with labels above/below (horizontal) and
left/right (vertical).

### Convert an existing `CD` block in place

Command palette → **"Convert CD block to editable diagram"** (cursor inside a
`$$\begin{CD}…\end{CD}$$` block, including bare or `\[ … \]`-wrapped forms)
replaces it with an editable `cd` block that renders the same diagram — the
upgrade path from notes that already use native `CD`.

---

## Settings

- **Default grid size** — rows × columns for a freshly inserted diagram.
- **Default arrow head / line style** — applied to newly drawn arrows.
- **Click to edit diagrams** — on: click anywhere on a rendered diagram to edit;
  off (default): an Edit button appears on hover.
- **Show editor preview** — toggle the live rendered preview beneath the grid.

---

## Mobile

Rendering works everywhere — diagrams display correctly in Reading view and Live
Preview on mobile, and the `cd` blocks are plain text so they're fine in any
context. **Editing is desktop-only for v1**: the grid editor's press-drag-to-draw
and keyboard/roving-tabindex model aren't tuned for touch. Opening the editor on
mobile shows a notice instead of a broken surface. (`isDesktopOnly` in the
manifest is intentionally `false` so display mode still loads on mobile.)

---

## How rendering matches native `CD`

Rather than hardcoding font sizes and arrow weights (which would drift with your
theme and zoom), the renderer measures Obsidian's actual native
`$$\begin{CD}A \to B\end{CD}$$` output at runtime — its computed font-size and
arrow stroke-width — and derives the diagram's base size and arrow weight from
that, re-measuring on theme change. Row/column gaps floor at AMS's
`\arrowlength` (≈ 3 em) so a short-label diagram spaces identically to a native
`CD` block, and only stretches where content forces it. Strokes use
`currentColor` with `var(--text-normal)`, so diagrams track the theme exactly
like native math.

---

## Development

```
npm install
npm test           # unit + integration + perf tests (node:test + tsx)
npm run build      # tsc typecheck + esbuild production bundle -> main.js
npm run dev        # esbuild watch
node scripts/deploy.mjs   # build + install into a test vault + hot-reload
```

### Layout

```
src/
  main.ts                 triggers, commands, processors, settings wiring
  settings.ts             settings + tab
  diagram/
    model.ts              DiagramModel: types, parse/serialize, grid insert/delete
    render.ts             pure SVG renderer (shared by editor preview + display)
    cd-style-metrics.ts   measure native CD font-size/arrow weight at runtime
  editor/
    GridEditor.ts         the floating overlay (grid UI, cell/arrow editing)
    positioning.ts        viewport clamp/flip helper
  view/
    reading.ts            (in main.ts) Reading-view post-processor
    live-preview.ts       CM6 ViewPlugin/WidgetType (display only)
    edit-affordance.ts    click-vs-hover-to-edit, shared by both display paths
  interop/
    to-tikzcd.ts  from-tikzcd.ts  to-cd.ts  from-cd.ts
tests/
  model.spec.ts  render.spec.ts  interop.spec.ts  perf.spec.ts
verification/
  phase{1,3,4,5,6}-check.md   manual verification checklists per phase
```

---

## License

MIT.
