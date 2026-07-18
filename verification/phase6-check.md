# Phase 6 verification — hardening & release

CLAUDE.md §11, Phase 6: mobile, performance, README, and the Obsidian community
plugin submission checklist. Run after `node scripts/deploy.mjs` with the plugin
enabled in a real test vault.

> What shipped this phase:
> - **Mobile decision (§13):** editing is desktop-only for v1; display mode
>   works everywhere. `manifest.json` keeps `isDesktopOnly: false` so diagrams
>   render on mobile; the three open-editor entry points (`openEditor`,
>   `openEditorForExisting`, `onEditLivePreview`) soft-block on
>   `Platform.isMobileApp` with a notice. No broken surface on touch.
> - **Performance (§11/§12):** `tests/perf.spec.ts` bounds `layoutDiagram`,
>   the full SVG build, and the model grid ops on a dense 10×10 (and 20×20 for
>   scaling). Measured: 10×10 layout ≈ 3.5 ms, 20×20 ≈ 17.7 ms, 1000 model ops
>   ≈ 25 ms — all well under their CI budgets.
> - **README.md:** syntax reference, the insert → grid → commit flow, the `cd`
>   block format with a real example, import/export with a *real* generated
>   tikz-cd block, settings, mobile note, and the dev layout.
> - **Tests:** 66 pass (`npm test`); `npm run build` clean.

Automated gates:

- [x] `npm test` — 66 tests pass (62 prior + 4 perf).
- [x] `npm run build` — `tsc` + esbuild production build clean.

---

## Mobile (§13, §11)

The decision: **display everywhere, edit desktop-only.**

- [ ] `manifest.json` `isDesktopOnly` is `false` (so the plugin loads on mobile
      and diagrams render).
- [ ] On desktop: nothing changes — all three triggers open the editor; clicking
      a rendered diagram reopens it.
- [ ] On mobile (Obsidian mobile app): a `cd` block in Reading view renders the
      static SVG correctly (right size, theme-correct color, arrows/labels).
- [ ] On mobile: a `cd` block in Live Preview renders the static SVG correctly.
- [ ] On mobile: tapping a rendered diagram does **not** open a broken editor —
      it either shows the hover Edit button (which, tapped, shows the
      desktop-only notice) or, in click-to-edit mode, shows the notice directly.
      Either way the reader is told editing is desktop-only, not left with a
      half-mounted overlay.
- [ ] On mobile: the ribbon icon / command / right-click menu, if invoked, show
      the "desktop-only" notice and write nothing to the note.
- [ ] No console errors on mobile from the display path (MathJax measurement,
      SVG construction).

> Verified-by-design notes: the mobile guard is a single `Platform.isMobileApp`
> early-return at the top of each open-editor entry point, before any DOM is
> built, so there is no path that mounts the grid overlay on touch. Display mode
> never touches `Platform` at all — it's pure SVG.

---

## Performance (§11: large grid 10×10+)

Automated (`tests/perf.spec.ts`, already green):

- [x] `layoutDiagram` on a dense 10×10 (100 labelled cells + 20 arrows) < 50 ms
      (measured ≈ 3.5 ms).
- [x] `layoutDiagram` 20×20 < 400 ms and scales sub-quadratically vs 10×10
      (measured ≈ 17.7 ms, ratio well under 25×).
- [x] 1000 model grid ops (insert/delete row/col, trim) on a 10×10 < 50 ms
      (measured ≈ 25 ms) — the resize-mid-edit path.

Manual, in the real editor (these can't be asserted in node — they exercise the
GridEditor's drag feedback and MathJax typesetting):

- [ ] Open the editor, build a 10×10 grid (add rows/cols to 10×10, label every
      cell, draw ~20 arrows). The grid renders and re-renders without visible
      lag on each cell label / arrow add.
- [ ] Drag out a new arrow across a 10×10 grid: the live drag line follows the
      pointer smoothly (no jank).
- [ ] Edit an arrow's label in the properties popover on a 10×10: the live
      preview beneath the grid re-typesets within a beat (debounced 250 ms).
- [ ] Resize the grid (add/remove a row) on a 10×10 mid-edit: existing cells and
      arrows are preserved and re-render promptly.
- [ ] Reading view: a note with several `cd` blocks (incl. one 10×10) scrolls
      and renders without noticeable delay; re-rendering on theme change is
      prompt.
- [ ] Live Preview: scrolling past a 10×10 `cd` block widget is smooth; the
      widget appears without a layout jank once MathJax typesets.

---

## README (§11)

- [x] `README.md` exists at repo root.
- [x] Explains the two-mode design (edit = transient grid, display = static SVG).
- [x] Documents the three insert triggers.
- [x] Documents the grid editor interactions: label a cell, drag to draw an
      arrow, arrow properties popover, add/remove rows & cols, commit/discard.
- [x] `cd` block format reference with a real example block + field table.
- [x] Import/export section with a **real generated** tikz-cd block (re-verified
      against `toTikzcd` output this phase) and the AMS-CD gating note.
- [x] Settings section.
- [x] Mobile note (display everywhere, edit desktop-only).
- [x] Install instructions (community browser + manual from source + dev deploy).
- [x] Dev commands (`npm test`, `npm run build`, `npm run dev`, deploy script).
- [x] Repo layout overview.
- [ ] **GIF** of the insert → grid → commit flow. (Placeholder: record with the
      plugin in the test vault — ribbon icon → label cells → drag arrows → click
      away → diagram renders → click to re-edit. Drop into `README.md` under
      "How it works." Not a code gate; add before the community submission.)

> README tikz-cd example was regenerated this phase with
> `toTikzcd(pullbackModel)` and matches the actual emitter verbatim, so the docs
> can't drift from the code.

---

## Obsidian community plugin submission checklist

The [plugin review checklist](https://github.com/obsidianmd/obsidian-releases/blob/master/plugin-review.md),
ticked against this repo:

### General
- [x] Has a clear README describing features, with screenshots/GIF and install
      instructions. (GIF pending — see above.)
- [x] Has a `LICENSE` (MIT) at repo root.
- [x] Has `manifest.json` with `id`, `name`, `version`, `minAppVersion`,
      `description`, `author`, `authorUrl`, `isDesktopOnly`.
- [ ] `author` / `authorUrl` point to the real maintainer (currently placeholder
      `cdrawer` / a generic URL — update before submitting).
- [x] Repo name and plugin `id` are consistent and don't collide with an
      existing community plugin (`cdrawer` / `cdrawer`).

### Code / safety
- [x] No `eval`, no `Function(...)` of dynamic strings, no `innerHTML` of
      untrusted input. (Labels go through Obsidian's `renderMath` / text
      `textContent`, never `innerHTML`.)
- [x] No network calls — fully offline.
- [x] No filesystem access outside `vault.process` / `vault.getAbstractFileByPath`
      for the user's own note, and only on commit of an edited block.
- [x] No `localStorage` / globals beyond the module-level `activeEditor` and the
      cached style metrics (both cleaned up on close / theme change).
- [x] No DOM left behind: the overlay removes itself on close; the hidden label
      / style-measurement hosts are removed after use.
- [x] Event listeners added on mount are removed on close (`pointerdown`,
      `keydown` capture handlers; window drag listeners are tied to the gesture
      and cleaned on `pointerup`).
- [x] Settings are loaded/saved through the plugin's `loadData`/`saveData`.
- [x] No bundled second math renderer — uses Obsidian's built-in MathJax
      (`renderMath`), per the plan.

### Obsidian API usage
- [x] Uses `registerMarkdownCodeBlockProcessor("cd", …)` for Reading view.
- [x] Uses `registerEditorExtension` for the CM6 Live Preview widget.
- [x] Uses `addRibbonIcon`, `addCommand` (`editorCallback`), `addSettingTab`,
      and `registerEvent(app.workspace.on("editor-menu", …))`.
- [x] `minAppVersion` is `1.4.0` (CM6 + the APIs used are stable since then).
- [x] The CM6 transaction dispatch preserves undo/redo/sync (verified in Phase 3
      / Phase 5 checklists).

### Release hygiene
- [ ] `main.js` is the production bundle (esbuild, minified) — confirm the
      submitted `main.js` is a clean `npm run build` artifact.
- [ ] Version in `manifest.json` is a real release tag (bump from `0.1.0`
      before submission).
- [ ] `.github/` release workflow / or a tagged release exists for the submitted
      version (Obsidian requires a GitHub release with `main.js`, `manifest.json`,
      `styles.css` attached).
- [ ] Submit via the [community-plugin submission form](https://github.com/obsidianmd/obsidian-releases/issues)
      with the repo URL.

---

## v1.0 Definition of Done (CLAUDE.md §14) — re-check

Carried forward from prior phase checks; re-confirm nothing regressed this phase:

- [ ] Insert via ribbon, command palette, and right-click all open the editor at
      the cursor (desktop).
- [ ] Grid editor: add/remove rows & cols without corrupting cells/arrows; click
      to label; drag to draw; select an arrow to edit style; commit on
      outside-click/Escape; discard only via the button.
- [ ] Rendered diagrams visually match native `CD` in light, dark, and one
      third-party theme.
- [ ] Clicking a rendered diagram (Reading view + Live Preview) reopens the
      editor pre-filled and positioned.
- [ ] `\begin{CD}` blocks convert in place to editable `cd` blocks.
- [ ] Export to tikz-cd compiles unmodified in a real LaTeX document for every
      fixture.
- [ ] Undo/redo and file sync (second vault window) don't corrupt the JSON.
- [ ] Passes the Obsidian community plugin review checklist (above).
