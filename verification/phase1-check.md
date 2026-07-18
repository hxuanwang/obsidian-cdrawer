# Phase 1 verification gate

Manual checklist for **Phase 1 — static renderer + CD style match** (CLAUDE.md §11, §6.4).
Open this note in a real test vault with the plugin enabled and check each item
in **light theme AND dark theme** (and ideally one third-party theme).

> How to use this note in a vault: this repo is a plugin, not a vault. Symlink
> or copy `main.js`, `manifest.json`, `styles.css` into
> `<vault>/.obsidian/plugins/cdrawer/`, enable the plugin, then open
> this file (copy it into the vault) in Reading view.

---

## §6.4 verification gate — side-by-side visual match

The `cd` block below should read as the **same visual family** as the native
`$$\begin{CD}$$` block immediately after it: same font size, same arrow weight
(thin, single-stroke — not TikZ's chunkier heads), same row/column spacing.

### Editable `cd` block

```cd
{
  "version": 1,
  "rows": 3,
  "cols": 3,
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

### Native `CD` reference

$$\begin{CD}
A @>f>> B \\
@VgVV @VVhV \\
C @>>k> D
\end{CD}$$

**Check (both themes):**
- [ ] Font size of the labels matches the native block.
- [ ] Arrow stroke weight matches (thin, not chunky).
- [ ] Arrowhead proportions match (small single-stroke chevron).
- [ ] Row/column spacing matches when labels are short (the `minGap` floor ≈ `\arrowlength`).
- [ ] Text color matches `var(--text-normal)` and tracks theme.

---

## Full vocabulary sample

A hand-written model exercising every Phase 1 rendering feature: straight /
vertical / diagonal / skip arrows, a bidirectional (iso) arrow, hook / epi /
mapsto heads, dashed and dotted lines, and sub/superscript labels.

```cd
{
  "version": 1,
  "rows": 3,
  "cols": 3,
  "cells": [
    { "row": 0, "col": 0, "label": "A" },
    { "row": 0, "col": 1, "label": "B" },
    { "row": 0, "col": 2, "label": "X^{n}" },
    { "row": 1, "col": 0, "label": "C" },
    { "row": 1, "col": 1, "label": "D" },
    { "row": 2, "col": 2, "label": "Y_{k}" }
  ],
  "arrows": [
    { "from": { "row": 0, "col": 0 }, "to": { "row": 0, "col": 1 }, "label": "f", "id": "a1" },
    { "from": { "row": 0, "col": 0 }, "to": { "row": 1, "col": 0 }, "label": "g", "labelPosition": "right", "id": "a2" },
    { "from": { "row": 0, "col": 0 }, "to": { "row": 1, "col": 1 }, "label": "h", "labelPosition": "above", "id": "a3" },
    { "from": { "row": 0, "col": 1 }, "to": { "row": 0, "col": 2 }, "label": "\\phi", "id": "a4" },
    { "from": { "row": 0, "col": 1 }, "to": { "row": 1, "col": 1 }, "head": "hook", "label": "i", "id": "a6" },
    { "from": { "row": 0, "col": 2 }, "to": { "row": 2, "col": 2 }, "lineStyle": "dotted", "id": "a9" },
    { "from": { "row": 1, "col": 0 }, "to": { "row": 0, "col": 1 }, "head": "epi", "id": "a7" },
    { "from": { "row": 1, "col": 0 }, "to": { "row": 1, "col": 1 }, "bidirectional": true, "label": "\\sim", "id": "a5" },
    { "from": { "row": 1, "col": 1 }, "to": { "row": 2, "col": 2 }, "head": "mapsto", "lineStyle": "dashed", "id": "a8" }
  ]
}
```

**Check:**
- [ ] All five objects (A B Xⁿ C D Yₖ) render with sub/superscripts intact.
- [ ] Straight (A→B), vertical (A→C), and diagonal (A→D) arrows clip to label edges, not centers.
- [ ] Skip arrow B→Xⁿ is a straight line across col 1's gap (no routing).
- [ ] Bidirectional C↔D shows a head at both ends.
- [ ] hook (B→D), epi (C→B), mapsto (D→Yₖ) heads render with the right tail/head glyph.
- [ ] Dashed (D→Yₖ) and dotted (Xⁿ→Yₖ) line styles render.
- [ ] Arrow labels sit clear of their shafts; `above`/`right`/default positions are sensible.

---

## Error handling

- [ ] A malformed `cd` block shows an inline error message, not a broken render:

```cd
{ not valid json
```
