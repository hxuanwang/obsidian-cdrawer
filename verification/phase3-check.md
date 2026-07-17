# Phase 3 verification

Manual checklist for **Phase 3 — Live Preview display + click-to-reedit**
(CLAUDE.md §11, §8.2). Run with the plugin enabled in a real test vault, after
`node scripts/deploy.mjs` (or copying `main.js` / `manifest.json` / `styles.css`
into `<vault>/.obsidian/plugins/obsidian-cdrawer/`).

> Test in **Live Preview** (the default editing view) and **Reading view**,
> in light theme AND dark theme.

---

## Live Preview display (§8.2)

Switch the note to Live Preview. The `cd` block below should render as a static
SVG inline, the same diagram the Reading view shows — not as raw fenced code —
as long as the cursor is **not** inside the block.

```cd
{
  "version": 1,
  "rows": 2,
  "cols": 2,
  "cells": [
    { "row": 0, "col": 0, "label": "A" },
    { "row": 0, "col": 1, "label": "B" },
    { "row": 1, "col": 0, "label": "C" },
    { "row": 1, "col": 1, "label": "D" }
  ],
  "arrows": [
    { "from": { "row": 0, "col": 0 }, "to": { "row": 0, "col": 1 }, "label": "f", "id": "a1" },
    { "from": { "row": 0, "col": 0 }, "to": { "row": 1, "col": 0 }, "label": "g", "id": "a2" },
    { "from": { "row": 0, "col": 1 }, "to": { "row": 1, "col": 1 }, "label": "h", "id": "a3" },
    { "from": { "row": 1, "col": 0 }, "to": { "row": 1, "col": 1 }, "label": "k", "id": "a4" }
  ]
}
```

**Check:**
- [ ] In Live Preview with the cursor elsewhere, the block renders as a diagram
      (not raw ```cd JSON).
- [ ] Clicking into the block's lines shows the raw source (Obsidian's own
      fenced-code behavior), and moving the cursor away re-renders the widget.
- [ ] The Live Preview diagram looks identical to the Reading-view rendering of
      the same block.
- [ ] A malformed block shows an inline `cd:` error, not a broken render.
- [ ] Bad LaTeX in a label degrades gracefully (verbatim fallback), in both views.

## Click-to-reedit (§8.2)

- [ ] In Live Preview, clicking the rendered diagram opens the floating grid
      editor prefilled with the block's model, anchored over the block.
- [ ] Editing a label / drawing an arrow, then clicking outside (or pressing
      Escape), commits: the block's JSON is rewritten and the widget re-renders
      with the new diagram.
- [ ] Emptying the diagram entirely (no labels, no arrows) and committing
      **removes** the block from the note (no empty ```cd{}\n``` left behind).
- [ ] In Reading view, clicking a diagram likewise reopens the editor prefilled
      and writes back on commit (Phase 1/2 path, still working).
- [ ] Undo (Ctrl/Cmd+Z) after a Live Preview commit restores the previous block.
- [ ] Opening a second vault window on the same note: editing in one updates
      the other (file sync) without corrupting the JSON.

## Scroll-while-open (§7.2 / §13)

- [ ] With the grid editor open, scrolling the note does not silently lose work;
      the overlay stays usable (dismissal is via outside-click / Escape / Discard,
      per the v1 decision documented in GridEditor.ts).

## Multiple blocks

```cd
{ "version": 1, "rows": 1, "cols": 2, "cells": [{ "row": 0, "col": 0, "label": "X" }, { "row": 0, "col": 1, "label": "Y" }], "arrows": [{ "from": { "row": 0, "col": 0 }, "to": { "row": 0, "col": 1 }, "id": "a1" }] }
```

Some prose between blocks.

```cd
{ "version": 1, "rows": 1, "cols": 2, "cells": [{ "row": 0, "col": 0, "label": "U" }, { "row": 0, "col": 1, "label": "V" }], "arrows": [{ "from": { "row": 0, "col": 0 }, "to": { "row": 0, "col": 1 }, "id": "a1" }] }
```

- [ ] Both blocks render independently in Live Preview; editing one rewrites
      only that block.
