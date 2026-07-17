# Phase 4 verification

Manual checklist for **Phase 4 — arrow/head polish + settings + accessibility**
(CLAUDE.md §11, §6.3, §8.3, §7.3). Run with the plugin enabled in a real test
vault after `node scripts/deploy.mjs`.

> The full arrow/head/line-style/bidirectional/label-position vocabulary was
> already implemented in Phase 2's properties popover; Phase 4 adds **settings**,
> the **click-vs-hover-to-edit** toggle, and the **keyboard/a11y pass**.

---

## Settings tab (§8.3)

Open Settings → Community plugins → Commutative Diagram.

- [ ] "Default grid size" rows/cols fields accept 1–20; setting e.g. 4×2 makes a
      fresh "Insert commutative diagram" open a 4-row × 2-col grid.
- [ ] "Default arrow head" dropdown (Default/Epi/Hook/Mapsto/None) sets the head
      of newly drawn arrows.
- [ ] "Default arrow line style" (Solid/Dashed/Dotted) sets the line of newly
      drawn arrows.
- [ ] "Click to edit diagrams" toggle is **off** by default (safer).
- [ ] Changing a setting persists across reload (disable/enable the plugin).

## Click-vs-hover-to-edit (§8.3)

With **clickToEdit off** (default):
- [ ] In Reading view, a rendered diagram shows a small **Edit** button on hover
      (top-right); clicking it opens the grid editor.
- [ ] Clicking the diagram itself (not the button) does NOT open the editor —
      safe while reading/scrolling.
- [ ] In Live Preview, the same hover Edit button appears on the widget.
- [ ] Tab/keyboard focus can reach the Edit button (focus-visible).

With **clickToEdit on**:
- [ ] Clicking anywhere on the diagram (Reading + Live Preview) opens the editor
      immediately (the Phase 1–3 behavior); no hover button.

## Keyboard / accessibility (§7.3)

Open the grid editor, then use only the keyboard:

- [ ] On open, the top-left cell is focused (visible focus ring).
- [ ] Arrow keys move focus between cells (wraps at edges).
- [ ] Tab / Shift+Tab inside a cell input moves to the next/prev cell in reading
      order (existing Phase 2 behavior still works).
- [ ] Enter or Space on a focused cell opens its label editor; the input gets
      focus.
- [ ] After committing a cell edit (Enter / click away), focus returns to that
      cell (not lost).
- [ ] Adding/removing a row or column preserves focus on a sensible cell; the
      grid doesn't lose keyboard focus to the page.
- [ ] Escape: if a cell is being edited, cancels just that edit; if the
      properties popover is open, closes just it; otherwise commits the editor.
- [ ] Visible focus states are clear in both light and dark theme.
- [ ] Screen-reader sanity: cells expose `role="gridcell"` + an `aria-label`
      (verify in devtools if available).

## Arrow vocabulary regression (§6.3)

Build a diagram with each head style, each line style, a bidirectional arrow,
and label positions above/below/left/right — confirm the properties popover and
both render paths still match (Phase 2 functionality unchanged):
- [ ] All 5 heads, 3 line styles, bidirectional, and 4 label positions render in
      the editor preview, Reading view, and Live Preview identically.
