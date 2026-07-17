# Plan: Obsidian Commutative Diagram Plugin

**Working name:** `obsidian-cd-editor` (rename freely)

## 0. Goal, in one paragraph

Build an Obsidian plugin where the user triggers "Insert commutative diagram" (ribbon icon
or command palette), which opens a **fixed-grid editing surface anchored at the cursor** —
the same interaction model as tikzcd.yichuanshen.de (`tikzcd-editor`): a grid of cells, a
default size to start, cells can hold a LaTeX-labelled object or stay empty, arrows are drawn
by clicking/dragging between cells, and rows/columns can be inserted or removed. When the
user clicks outside that editing surface, it closes and the note gets a **static, inline
rendered diagram** at the cursor position — same visual weight, font size, arrow style, and
spacing as Obsidian's native `$$\begin{CD}...\end{CD}$$` rendering, so a reader can't tell
which mechanism produced it. Clicking the rendered diagram later reopens the same grid editor,
pre-filled, to make changes.

This is a two-mode design, not one always-interactive widget:
- **Edit mode** = a transient floating grid editor (exists only while open).
- **Display mode** = a static SVG, matched to CD's look, that lives permanently in the note.

Read this whole file before writing code.

## 1. Prior art (checked before writing this plan)

- **tikzcd-editor** (`yishn/tikzcd-editor`, powers tikzcd.yichuanshen.de) — this is the
  reference UX. Fixed rectangular grid of cells; click a cell to type a LaTeX label; drag from
  one cell to another to create an arrow; a properties panel edits the selected arrow's label
  and style; the grid can be resized. This is the interaction model to copy, not quiver's
  free-form continuous-coordinate canvas.
- **quiver.app** — richer (free node placement, curved/multi-headed arrows, higher-cell
  pasting diagrams), but that flexibility is exactly what makes it a separate destination site
  rather than something you'd casually pop open mid-note. Worth mining for *arrow style
  vocabulary* (head/tail/line variants, §6.3) but not for the grid/interaction model.
- **obsidian-tikzjax** (existing community plugin) — read-only, compiles arbitrary TikZ
  through a bundled WASM LaTeX engine. No authoring UI, and has an open sizing/scaling bug.
  Confirms there's no existing plugin that does what's being asked for here.
- **Obsidian's native `\begin{CD}\end{CD}`** — renders via MathJax's AMSmath extension:
  axis-aligned arrows only, single label above/below/left/right, font size inherited from
  surrounding math (`\displaystyle` sizing), thin plain arrowheads. This is the visual target
  for display mode (§6.4) — not a starting point for the editing model, since it can't express
  everything we want to author (only 8 arrow directions, one label per arrow, no styling).

## 2. Non-goals (v1)

- Free/continuous node placement (drag a node anywhere) — the grid is fixed-cell, like the
  reference editor. Users who want free placement should use quiver externally.
- Higher-cell "pasting diagrams" (arrows between arrows).
- Real-time multi-user collaboration.
- Auto-layout beyond grid resize.

## 3. Core architecture

```
Trigger (ribbon icon / command / click an existing diagram)
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ Floating Grid Editor (transient, DOM overlay, not a Modal) │
│  - positioned at editor.coordsAtPos(cursor)                │
│  - owns a draft DiagramModel (grid cells + arrows)         │
│  - grid resize controls, cell label editing, arrow drawing │
│  - closes on outside click / Escape                        │
└───────────────────────────────────────────────────────────┘
        │  on close: serialize draft model
        ▼
┌───────────────────────────────────────────────────────────┐
│ ```cd fenced code block in the markdown source              │
│ (pretty-printed JSON: grid dims, cells, arrows)             │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ Static renderer (MarkdownPostProcessor + CM6 widget)        │
│  model -> SVG, styled to match \begin{CD}\end{CD}           │
│  click anywhere on it -> reopens the Floating Grid Editor,  │
│  pre-filled with this block's model                         │
└───────────────────────────────────────────────────────────┘
```

Key implication of this two-mode split: the **static renderer never needs pointer-driven
mutation logic** (no drag handlers, no in-place resize) — it only needs to render and to
detect "was I clicked, if so open the editor." All the interaction complexity lives in one
place, the floating grid editor, and that editor is not tied to CM6 decoration lifecycle at
all — it's a plain positioned `<div>` appended to `document.body` (or the active
`.workspace-leaf`) while open, which is much simpler to get right than a live CM6 widget with
internal drag state. Build the grid editor and the static renderer as two independent,
framework-agnostic TS modules that share only the `DiagramModel` type and the SVG rendering
function (the editor renders a live preview of the draft using the exact same `render.ts` used
for display mode, so what you see while editing is what you get after committing).

## 4. Data model

Grid-based, integer cell coordinates — not the continuous/free coordinates a quiver-style tool
would use:

```ts
// src/diagram/model.ts

interface DiagramCell {
  row: number;            // 0-indexed
  col: number;
  label: string;          // LaTeX source; empty string = unoccupied cell (no object drawn)
}

type ArrowHead = "default" | "epi" | "hook" | "mapsto" | "none";
type LineStyle = "solid" | "dashed" | "dotted";

interface DiagramArrow {
  id: string;
  from: { row: number; col: number };
  to:   { row: number; col: number };
  label?: string;                 // LaTeX source
  labelPosition?: "left" | "right" | "above" | "below"; // relative to arrow direction
  head?: ArrowHead;
  lineStyle?: LineStyle;
  bidirectional?: boolean;        // renders as <-> (equivalence / iso), common in CD-style diagrams
}

interface DiagramModel {
  version: 1;
  rows: number;
  cols: number;
  cells: DiagramCell[];           // sparse: omit fully-empty cells after row/col trim on commit
  arrows: DiagramArrow[];
}
```

Design notes:
- `rows`/`cols` are the authoritative grid extent; `cells`/`arrows` reference positions inside
  it. Row/column insert or delete (§7.3) is a pure function: `insertRow(model, atIndex)` /
  `deleteCol(model, atIndex)`, shifting affected cell/arrow coordinates and re-indexing arrow
  endpoints — write these as isolated, unit-testable functions before wiring any UI to them,
  since off-by-one errors here silently corrupt existing arrows.
- Arrows are allowed between **any** two cells, not just orthogonal neighbors — confirm exact
  reference behavior against tikzcd-editor for diagonal and "skip" (non-adjacent) arrows before
  finalizing the renderer's path logic (§6.2); replicate what the reference tool does rather
  than inventing new behavior, since matching it is the explicit brief.
- `label` on cells/arrows is raw LaTeX, rendered via Obsidian's built-in `renderMath()` (wraps
  MathJax) — same as the model in the original draft of this plan; don't bundle a second math
  renderer.
- Round-trip requirement: `parse(serialize(model))` deep-equals `model`. Write this test first.
- Schema is additive-only once shipped (new optional fields only) since it's persisted as plain
  text in users' vaults.
- On commit (editor closes), trim fully-empty trailing rows/columns (no cell label, no arrow
  endpoint referencing them) so the stored grid isn't larger than what the user actually used —
  keeps the fenced block's JSON small and keeps re-opening the editor from showing a bunch of
  dead empty cells the user deliberately shrank away.

## 5. Fenced code block syntax

```
```cd
{"version":1,"rows":3,"cols":3,"cells":[...],"arrows":[...]}
```
```

Pretty-print with 2-space indentation on every write (readability if the user opens source
mode; sane diffs in version control). Dedicated `cd` language tag so it doesn't collide with
`tikz` (obsidian-tikzjax) or math `CD` blocks.

## 6. Rendering

`src/diagram/render.ts` — pure function `renderDiagram(model: DiagramModel, opts): SVGElement`.
Used identically by (a) the live draft-preview inside the floating grid editor and (b) the
static display-mode renderer — one implementation, two call sites.

### 6.1 Layout
- Grid cell size is **not** fixed in pixels; like TikZ's matrix, a row's height / column's
  width is driven by the largest rendered label in that row/column (measure each cell's
  rendered `renderMath()` output, then lay out the grid from those measurements). This matches
  both tikz-cd's own behavior and quiver's, and avoids clipped/cramped labels.
- Empty cells (no label, but still inside `rows × cols`) still reserve grid space if an arrow
  passes through or terminates near them — but per §4, empty *trailing* rows/cols are trimmed
  on commit, so in practice empty cells only exist as deliberate spacing inside a diagram, not
  as accidental padding.

### 6.2 Arrows
- Straight line between the two cells' anchor points (edge of each cell's bounding box, not
  its center, so the line/arrowhead doesn't run under the label) for orthogonal and diagonal
  neighbor pairs.
- Non-adjacent ("skip") arrows: draw as a straight line from source to target regardless of
  what's in between, the same way the reference editor does — do not attempt automatic routing
  around intervening cells; that's out of scope and not what tikzcd-editor does either.
- Multiple arrows between the same pair of cells: offset them a fixed perpendicular distance,
  symmetric around the centerline (same technique as any of the reference tools).
- `bidirectional: true` renders a double-headed arrow (used for isomorphisms/equivalences,
  which show up constantly in this domain and are worth a first-class flag rather than forcing
  the user to fake it with two overlapping arrows).

### 6.3 Arrow head/line vocabulary (v1 scope)
Deliberately smaller than quiver's full vocabulary — cover what maps cleanly onto both AMS
`CD` and `tikz-cd` so import/export (§9) stays lossless in both directions:
`head`: `default` (plain arrowhead), `epi` (twin arrowhead, ↠), `hook` (↪), `mapsto` (↦),
`none` (no head, e.g. for a plain line or as one side of a manually-built double arrow).
`lineStyle`: `solid`, `dashed`, `dotted`. That's the full v1 set — resist scope creep here,
it's an explicit non-goal (§2) to chase quiver's full head/tail/body matrix.

### 6.4 Matching `\begin{CD}\end{CD}` styling — concrete, not just "similar"
This is a hard requirement from the brief ("same size and style"), so don't eyeball it:
- At render time, render a hidden reference `$$\begin{CD}A \\to B\end{CD}$$` once (or reuse
  Obsidian's existing rendered CD elements already in the note, if any exist on the page) and
  read its computed font-size / line-height via `getComputedStyle()`. Use that as the base font
  size for cell labels, rather than a hardcoded value — this keeps the diagram in sync
  automatically if the user changes their vault's math font size, zoom level, or theme.
  Confirm this hidden-render technique doesn't cause a visible flash; if it does, cache the
  measurement per document/theme-change rather than re-measuring on every diagram.
- Arrowheads: thin, simple, single-stroke — match MathJax/AMS's arrow glyph weight, not
  TikZ's default (which is visibly chunkier/rounder). Look at Obsidian's actual rendered
  `\begin{CD}` output (inspect the generated SVG/MathML in devtools against a real Obsidian
  install) and match stroke-width and head proportions numerically, don't guess.
  Do this as one of the first tasks in Phase 1 — it's cheap to check and everything else in §6
  is built on top of it.
  Do this as one of the first tasks in Phase 1 — it's cheap to check and everything else in §6
  is built on top of it.
- Row/column spacing: AMS `CD` uses a fixed arrow length (`\arrowlength`, ~1.25× the line
  height by default); replicate that ratio for the *minimum* row/column gap, then grow further
  only as needed to fit label content per §6.1 — so a diagram with short labels looks
  identically spaced to a native `CD` block, and only stretches where content forces it to.
- Text color, background: transparent background, `var(--text-normal)` for default line/label
  color so it's theme-correct exactly like native math — same guidance as the original plan.
- **Verification gate**: before Phase 1 is considered done, place a `cd` diagram and a native
  `$$\begin{CD}A \to B \\ \downarrow \quad \downarrow \\ C \to D\end{CD}$$` side by side in a
  test note and confirm at a glance they read as the same visual family (font size, arrow
  weight, spacing) in both light and dark theme. This is a manual check, not just a unit test —
  add it to the Phase 1 checklist explicitly.

## 7. The floating grid editor (the main new feature)

### 7.1 Trigger
- Ribbon icon (`addRibbonIcon`) — icon suggestion: a small grid/matrix glyph, distinct from
  Obsidian's existing icons.
- Command (`addCommand`, shows in command palette and is bindable to a hotkey): "Insert
  commutative diagram." Only enabled (`editorCallback`) when a markdown editor is focused.
- Right-click context menu: `registerEvent(app.workspace.on("editor-menu", ...))` to add
  "Insert commutative diagram" to the editor's right-click menu, since Obsidian has no generic
  "Insert" menu a plugin can hook into directly — ribbon + command palette + this context menu
  together cover the discoverability the brief's "Insert -> ..." phrasing implies.
- Clicking an existing rendered `cd` diagram (§8) also opens this same editor, pre-filled from
  that block's model, positioned over/near the diagram rather than at a fresh cursor location.

### 7.2 Positioning
- On trigger from the ribbon/command/context-menu, record the current cursor position
  (`editor.getCursor()`), get its pixel location via `editor.coordsAtPos(cursor)`, and mount
  the grid editor as an absolutely-positioned overlay near those coordinates.
- Not an Obsidian `Modal` — a `Modal` traps focus and centers itself, which doesn't match "grid
  appears at the cursor, click outside to dismiss." Build a plain overlay `<div>` (fixed
  positioning, high z-index) with its own outside-click/Escape handling
  (`document.addEventListener("pointerdown", ...)` on mount, checking `event.target` isn't
  inside the overlay's root element; remove the listener on unmount).
- Clamp/flip the overlay's position so it stays inside the visible viewport when the cursor is
  near a window edge (standard popover positioning problem — check for an existing small
  positioning utility before hand-rolling one, but don't pull in a heavy dependency for this).
- Scroll behavior: if the note scrolls while the editor is open (e.g. via keyboard), either
  reposition the overlay to track the cursor's new screen position or close it — pick one
  explicitly and document the choice; don't leave it to accidentally do whatever the browser
  does with a `position: fixed` element while the page scrolls underneath it.

### 7.3 Grid UI
- Renders a grid of cell boxes, `model.rows × model.cols`, default size on fresh insert
  (recommend 3×3 — small enough to read as a starting scaffold, big enough to not immediately
  need resizing for a typical square/pullback diagram).
- Row/column resize controls: a `+` affordance past the last column (adds a column) and past
  the last row (adds a row); a small `–`/remove control on each row/column header to delete it
  (only when it's safe — i.e. block/warn if deleting would delete a non-empty cell or an arrow
  endpoint, rather than silently destroying content; a simple confirm-if-destructive is enough
  for v1).
- Click an empty cell → focuses an inline text `<input>` for its LaTeX label; typing shows a
  debounced live MathJax preview in place. Click a cell that already has a label → same, prefilled.
- Draw an arrow: press-and-drag from at or near a cell's edge to another cell; on release,
  create the arrow (default head/line style from settings). Starting a drag from inside a cell
  that's mid-label-edit should not conflict with text selection inside the input — scope the
  drag-start hit area to the cell's border region, not its whole interior, so editing text and
  drawing arrows don't fight over the same mouse-down.
- Select an arrow (click it) → small inline properties popover: label text field, label
  position, head style dropdown (§6.3's 5 options), line style dropdown, bidirectional
  toggle, delete button.
- Keyboard: Escape closes the editor (discarding is *not* the default — see §7.4); Tab/Shift+Tab
  moves focus between cells in reading order, consistent with the accessibility expectations
  raised against the reference editor's own issue tracker (cited in §1) — don't skip this, it's
  a known rough edge in the tool we're modeling the UX on, worth doing better.

### 7.4 Commit / discard
- Click outside the overlay, or blur it in a way that isn't just moving focus between two of
  its own inputs (careful here — clicking from one cell's input to another cell should *not*
  count as "outside"), commits: serialize the current draft `DiagramModel`, trim trailing empty
  rows/cols (§4), and write it into the note as a ` ```cd ` fenced block at the recorded cursor
  position (`editor.replaceRange`) — inserting a fresh block on first creation, or replacing
  the existing block's text range when re-editing.
- Escape also commits (matches most inline-editor conventions in Obsidian, e.g. inline title
  editing) rather than discarding — an explicit "Discard" affordance (small button in the
  overlay chrome) is the only way to throw away changes, so a stray Escape can't silently lose
  work.
- If the draft is entirely empty (no cells have labels, no arrows) on commit, don't insert an
  empty block at all — just close, as if nothing happened. Avoids littering notes with empty
  ` ```cd\n{}\n``` ` blocks from accidental triggers.

## 8. Obsidian integration for display mode

### 8.1 Reading view
`registerMarkdownCodeBlockProcessor("cd", (source, el, ctx) => {...})`: parse `source`, call
the shared `render.ts` to build the static SVG, mount it into `el`. Attach a single click
handler on the mounted SVG that opens the floating grid editor (§7) pre-filled with the parsed
model, positioned over the diagram's on-screen bounding box, and — on commit — writes back via
`ctx.getSectionInfo(el)`'s line range + `app.vault.process`.

### 8.2 Live Preview
A CM6 `ViewPlugin` that finds ` ```cd ` fenced ranges via `syntaxTree` (as in the earlier draft
of this plan) and replaces them with a `WidgetType` rendering the same static SVG — but note
this is now **much simpler than previously planned**, because the widget itself has no
interaction logic: it just renders and, on click, opens the same floating grid editor described
in §7 (which is *not* part of the CM6 widget's own lifecycle — it's a separate overlay mounted
independently, sidestepping the fiddly "cursor inside vs outside the block" toggling logic the
original in-place-editing design would have needed). On commit, dispatch a CM6 transaction
replacing the block's text, same mechanism as before, so undo/redo/sync still work correctly.

### 8.3 Settings
- Default grid size for new diagrams (rows × cols).
- Default arrow head/line style for newly drawn arrows.
- Toggle: clicking a rendered diagram opens the editor immediately vs. shows a small edit-icon
  affordance on hover first (some users may find click-to-edit too easy to trigger by accident
  while reading/scrolling — offer the safer default, let power users turn it off).

## 9. Import / export

Unchanged in substance from the original draft of this plan — still a first-class feature,
since the point of authoring these is that they leave Obsidian and end up in a paper:

- **Export to tikz-cd**: `DiagramModel -> string`, mapping the grid directly onto tikz-cd's
  row/column matrix syntax (this direction is now *more* natural than before, since our model
  is already grid-shaped like tikz-cd's own, rather than needing to snap free coordinates to a
  grid). Arrow options (`\arrow[r, "f", hook]`, `\arrow[d, "g"']`, etc.) map directly from
  `head`/`lineStyle`/`bidirectional`.
- **Export to plain AMS `CD`**: possible whenever every arrow connects orthogonally-adjacent
  cells with at most one label — detect this and offer the export; disable with an explanatory
  tooltip otherwise (e.g. "contains a diagonal or skipped arrow — export as tikz-cd instead").
- **Import from tikz-cd**: small dedicated parser for the tikz-cd subset (matrix grid + basic
  `\arrow[...]` options) — not general TikZ.
- **Import from plain `CD`**: parse `\begin{CD}...\end{CD}` directly into a `DiagramModel`, and
  offer a command "Convert CD block to editable diagram" when the cursor is inside one — this
  is what fulfils "renders similar to `\begin{CD}\end{CD}`" as an *upgrade path* for existing
  notes, not just a stylistic target.
- Stretch (post-v1): import from a quiver.app share URL.

## 10. Suggested repo layout

```
obsidian-cd-editor/
  manifest.json
  package.json
  esbuild.config.mjs
  src/
    main.ts                    (registers processor, CM6 extension, ribbon icon, commands, editor-menu, settings tab)
    settings.ts
    diagram/
      model.ts                  (§4 types + parse/serialize + grid insert/delete row/col + tests)
      render.ts                  (§6 pure SVG renderer, shared by editor preview & display mode)
      cd-style-metrics.ts          (§6.4: measure native CD font-size/arrow weight at runtime)
    editor/
      GridEditor.ts               (§7: the floating overlay — grid UI, cell/arrow editing, positioning)
      positioning.ts               (clamp/flip-to-viewport helper)
    view/
      reading.ts                   (§8.1 MarkdownPostProcessor adapter)
      live-preview.ts               (§8.2 CM6 ViewPlugin/WidgetType adapter — display only)
    interop/
      to-tikzcd.ts
      from-tikzcd.ts
      to-cd.ts
      from-cd.ts
  tests/
    model.spec.ts                (round-trip + grid insert/delete correctness)
    render.spec.ts                 (SVG structure assertions for known models)
    interop.spec.ts                  (fixture-based parse/emit for tikz-cd and CD)
  styles.css
  README.md
```

## 11. Build phases

**Phase 0 — scaffold**
- Standard Obsidian sample-plugin skeleton (esbuild + TS + manifest.json); confirm a no-op
  `cd` code block processor loads in a real test vault before anything else.

**Phase 1 — static renderer + CD style match**
- Implement `model.ts` (types, parse/serialize, round-trip test, row/col insert/delete
  functions + their tests).
- Implement `cd-style-metrics.ts` and `render.ts` together, gated by the §6.4 verification
  check (side-by-side against a native `\begin{CD}\end{CD}` block, light + dark theme) — don't
  move on until this passes; it's the "same size and style" requirement from the brief and
  everything downstream assumes it's correct.
- Wire into the Reading-view post processor (§8.1), read-only (no click-to-edit yet): confirm
  a hand-written sample `DiagramModel` (straight arrows, one diagonal, one skip arrow, one
  bidirectional arrow, one hook/epi/mapsto head each, a dashed line, sub/superscript labels)
  renders correctly end-to-end in a real note.

**Phase 2 — the floating grid editor**
- This is the core feature. Build `GridEditor.ts` per §7 as a standalone component first —
  develop/test it mounted in a scratch HTML page or a minimal harness before wiring it into
  Obsidian's cursor-position trigger, so grid/cell/arrow interaction bugs are cheap to iterate
  on without reloading the whole plugin each time.
- Wire the ribbon icon, command, and editor-menu triggers (§7.1); implement cursor-position
  overlay mounting (§7.2); implement commit/discard writing into the note (§7.4).
- At the end of this phase, "Insert commutative diagram" → grid appears at cursor → build a
  diagram → click away → diagram renders in the note" must work fully in Reading view, using
  the Phase 1 renderer for both the live draft preview and the committed display.

**Phase 3 — Live Preview display + click-to-reedit**
- CM6 `ViewPlugin`/`WidgetType` for display mode in Live Preview (§8.2) — now a much smaller
  task than in the original draft of this plan, since it's render-only.
- Click-to-reopen the grid editor from both Reading view and Live Preview, prefilled from the
  clicked block's model, positioned over that block rather than at a fresh cursor.
- Verify the scroll-while-open behavior decision from §7.2 works as intended.

**Phase 4 — arrow/head polish + settings**
- All 5 head styles, 3 line styles, bidirectional toggle, arrow label positioning — full §6.3
  vocabulary in the properties popover.
- Settings tab (§8.3): default grid size, default arrow style, click-vs-hover-to-edit toggle.
- Accessibility pass on the grid editor: keyboard cell navigation (Tab/Shift+Tab, per §7.3),
  visible focus states, since this is a known weak point in the reference tool worth improving
  on rather than copying.

**Phase 5 — interop**
- `to-tikzcd.ts` / `to-cd.ts` exporters, `from-tikzcd.ts` / `from-cd.ts` parsers, all with
  fixture-based tests — use real examples from the tikz-cd package documentation, not only
  self-generated ones, so the parser is tested against what a real user will actually paste.
- "Convert CD block to editable diagram" command (§9).

**Phase 6 — hardening & release**
- Mobile: confirm Reading view degrades gracefully (static SVG renders correctly; the grid
  editor overlay can be out-of-scope for touch in v1, but shouldn't visually break anything if
  a mobile user taps a diagram — decide and document whether editing is desktop-only for v1).
- Performance check on a large grid (10×10+) — both render time and the grid editor's own
  responsiveness while dragging out arrows.
- README with syntax reference, a GIF of the insert → grid → commit flow, import/export
  examples.
- Obsidian community plugin submission checklist.

## 12. Testing strategy

- Unit tests for `model.ts` (round-trip, and specifically grid insert/delete correctness —
  this is the easiest place for silent coordinate-shift bugs), `render.ts` (structural SVG
  assertions, not pixel snapshots), `interop/*` (fixture-based, both directions).
- Manual checklist, run before every release: insert a fresh diagram via each of the three
  triggers (ribbon/command/context-menu); build a pullback-square example entirely in the grid
  editor; resize the grid (add and remove rows/cols) mid-edit without losing existing content;
  click away to commit, then click the rendered diagram to re-edit it; discard vs. commit via
  Escape vs. the explicit discard button; convert an existing native `CD` block; export both
  formats and paste the tikz-cd output into a real LaTeX document to confirm it compiles;
  compare visually against a native `CD` block in light and dark theme and one third-party
  theme; test near a window edge to confirm the overlay clamps/flips correctly.

## 13. Open questions to resolve early

- Exact arrow behavior for non-adjacent ("skip") cell pairs — confirm against the actual
  reference editor's behavior (straight line through intervening cells) before finalizing
  `render.ts`'s path logic; this was flagged in §6.2 but is worth calling out again since it's
  easy to accidentally over-engineer (e.g. auto-routing around cells) instead of just matching
  the reference tool.
- Scroll-while-editor-is-open behavior (§7.2): reposition-to-follow vs. auto-close. Recommend
  auto-close-on-scroll as the simpler, more predictable v1 default; revisit if user feedback
  wants otherwise.
- Whether the grid editor should support touch/mobile at all in v1, or be explicitly
  desktop-only with `isDesktopOnly` scoped just to the *editing* feature while display mode
  still works everywhere (display mode has no reason to be desktop-only, since it's just SVG).
- Default grid size and default arrow style — 3×3 / plain arrows are the recommendation in this
  plan, but confirm against a few real commutative-diagram examples (pullback square, short
  exact sequence, naturality square) to see if a non-square default reads better.

## 14. Definition of done for v1.0

- [ ] "Insert commutative diagram" via ribbon icon, command palette, and right-click menu all
      open the grid editor at the cursor.
- [ ] Grid editor: add/remove rows and columns without corrupting existing cells/arrows; click
      cell to label; drag to draw an arrow; select an arrow to edit its style; commit on
      outside-click/Escape, discard only via the explicit control.
- [ ] Rendered diagrams pass the §6.4 side-by-side visual match against native `CD` blocks in
      light, dark, and one third-party theme.
- [ ] Clicking a rendered diagram (Reading view and Live Preview) reopens the grid editor
      pre-filled and correctly positioned.
- [ ] `\begin{CD}` blocks can be converted in place to editable `cd` blocks.
- [ ] Export to tikz-cd compiles unmodified in a real LaTeX document for every fixture in
      `tests/interop.spec.ts`.
- [ ] Undo/redo and file sync (test via a second vault window) don't corrupt the stored JSON.
- [ ] Passes Obsidian's community plugin review checklist.
