# Phase 5 verification

Manual checklist for **Phase 5 — interop** (CLAUDE.md §9, §11). Run with the
plugin enabled in a real test vault after `node scripts/deploy.mjs`.

> What shipped: four interop modules under `src/interop/` (`to-tikzcd`,
> `from-tikzcd`, `to-cd`, `from-cd`), fixture-based tests in
> `tests/interop.spec.ts`, and four commands wired into `main.ts`. The parsers
> cover the documented tikz-cd subset and the AMS `CD` environment; unknown
> tikz-cd options (bend, color, phantom, …) are ignored rather than throwing.

Automated gates (already green via `npm test` / `npm run build`):

- [x] `npm test` — 62 tests pass, including 25 interop tests (round-trips +
      real fixtures).
- [x] `npm run build` — `tsc` + esbuild production build clean.

---

## Commands (run from the command palette with the cursor inside a block)

### "Convert CD block to editable diagram" (§9 upgrade path)

- [ ] Place the cursor inside a `$$\begin{CD}…\end{CD}$$` math block; run the
      command → the block is replaced by a ` ```cd ` fenced block that renders
      the same diagram and is click-to-edit.
- [ ] Works when the CD env is bare (no `$$`) and when wrapped in `\[ … \]`.
- [ ] A multi-line CD block (cells across several lines) converts correctly.
- [ ] If the cursor is NOT inside a CD block, a notice explains "No
      \begin{CD}…\end{CD} block found at the cursor."
- [ ] Labels with `{…}` grouping (e.g. `@>{f(x)}>>`) convert to `f(x)`.
- [ ] All four arrow directions convert: `@>>>` `@<<<` `@VVV` `@AAA`, with
      labels above/below (horizontal) and left/right (vertical).

### "Export diagram as tikz-cd"

- [ ] Cursor inside a ` ```cd ` block → a ` ```tikzcd ` block is inserted on
      the line below, ready to copy.
- [ ] Head/line/bidirectional vocabulary maps correctly:
      `epi→two heads`, `hook→hook`, `mapsto→mapsto`, `none→no head`,
      `bidirectional→leftrightarrow`, `dashed`, `dotted`.
- [ ] Diagonal and skip arrows produce valid direction letters (`dr`, `rr`,
      `rrd`, …).
- [ ] A right-side (`labelPosition: "right"`) label gets the `swap` marker.

### "Export diagram as AMS CD" (§9 gating)

- [ ] A CD-expressible diagram (orthogonally-adjacent arrows, no styled heads,
      no bidirectional, solid lines) exports a `$$\begin{CD}…\end{CD}$$` block
      below.
- [ ] A diagram with a **diagonal/skip** arrow shows the notice "contains a
      diagonal or skipped arrow — export as tikz-cd instead" and emits nothing.
- [ ] A diagram with an **epi/hook/mapsto** head, a **bidirectional** arrow, or
      a **dashed/dotted** line is gated with the corresponding notice.

### "Import tikz-cd block as editable diagram"

- [ ] Cursor inside a ` ```tikzcd ` block → it's replaced by a ` ```cd ` block.
- [ ] Modern bracket form `\arrow[r, "f", two heads]` and legacy
      `\arrow{r}{f}` both parse.
- [ ] `"g"'` (swap) and `"g" swap` both place the label on the right side.
- [ ] Unknown options (`bend left=30`, `red`) are ignored; the rest of the
      diagram still imports.
- [ ] Multi-step (`rr`) and diagonal (`dr`/`ul`) directions resolve to the
      correct target cells.

---

## LaTeX compile gate (CLAUDE.md §14)

The hardest requirement: exported tikz-cd must compile unmodified in a real
LaTeX document. For each fixture below, paste the exported block into:

```latex
\documentclass{article}
\usepackage{tikz-cd}
\begin{document}
% paste here
\end{document}
```

- [ ] **Pullback square** — build in the grid editor (P, X, Y, Z with the four
      edge arrows), export to tikz-cd, compile. ✓
- [ ] **Short exact sequence** — `0 → A ↪ B` with a `hook` arrow; export +
      compile. ✓
- [ ] **Naturality square with a dashed diagonal** — export + compile. ✓
- [ ] **Isomorphism** — a `bidirectional` arrow labelled `\cong`; export +
      compile (renders `<->`). ✓
- [ ] **Full vocabulary** — one arrow per head style + each line style in a
      single diagram; export + compile. ✓

## Round-trip sanity

- [ ] Build a diagram in the grid editor → export to tikz-cd → import that
      tikz-cd block back → the resulting `cd` block renders identically to the
      original (cells, arrows, labels, styles).
- [ ] Convert a native `$$\begin{CD}…\end{CD}$$` block to `cd`, then export
      that `cd` block to AMS CD → it round-trips to an equivalent `CD` block.

## Undo/sync regression (CLAUDE.md §14)

- [ ] After "Convert CD block" or "Import tikz-cd", undo restores the original
      block text (single Ctrl/Cmd+Z).
- [ ] With a second vault window open on the same note, a convert/import/export
      syncs without corrupting the surrounding content.
