/**
 * src/editor/GridEditor.ts (§7)
 *
 * The floating grid editor — a transient DOM overlay (NOT an Obsidian Modal),
 * mounted as a fixed-positioned <div> near the cursor / target diagram. It owns
 * a draft DiagramModel, exposes:
 *   - a grid of cells; click to edit a LaTeX label with a debounced MathJax
 *     preview;
 *   - draw arrows by press-and-dragging from a cell's border band to another;
 *   - add/remove rows and columns (destructive deletes confirm first);
 *   - select an arrow → inline properties popover (label, position, head, line
 *     style, bidirectional, delete);
 *   - a live draft preview rendered with the SAME render.ts used for display
 *     mode (what you see is what you commit);
 *   - commit on outside-click / Escape; an explicit Discard button is the only
 *     way to throw changes away (§7.4 — a stray Escape must not lose work).
 *
 * It is deliberately framework-agnostic: it takes a document, an initial
 * model, an anchor point, and callbacks (onCommit / onDiscard). main.ts wires
 * it to Obsidian's editor + note.
 *
 * Scroll behavior (§7.2, §13): auto-close-on-scroll is the v1 default —
 * simpler and more predictable than repositioning to track the cursor.
 */

import {
  addArrow, appendCol, appendRow, cloneModel, colDeletionIsDestructive,
  createEmptyModel, deleteCol, deleteRow, getLabel, insertCol, insertRow,
  removeArrow, rowDeletionIsDestructive, setCellLabel, trimTrailing, updateArrow,
  CURVE_APEX_FRAC, CURVE_MAX, CURVE_MIN,
  type ArrowHead, type DiagramArrow, type DiagramModel, type LabelPosition, type LineStyle,
} from "../diagram/model";
import { renderDiagramAsync, type LabelRenderer } from "../diagram/render";
import { toTikzcd } from "../interop/to-tikzcd";
import { fromTikzcd } from "../interop/from-tikzcd";
import { toCD, canExportToCD } from "../interop/to-cd";
import { fromCD } from "../interop/from-cd";

/** The editor's presentation mode (feature #1).
 *  - "float"    : a draggable, resizable window with border/shadow/title chrome,
 *                 floating over the note at a fixed viewport position.
 *  - "embedded" : de-chromed (no window border/shadow/rounding; transparent
 *                 background) AND tracking the diagram's element so it scrolls
 *                 with the page — the grid reads as part of the note rather than
 *                 a popup. Requires a `followTarget` (the existing diagram's
 *                 SVG); a fresh insert has no diagram to track, so embedded
 *                 there de-chromes but stays fixed at the cursor. */
export type EditorMode = "float" | "embedded";

export interface GridEditorOptions {
  /** Document to mount into (the active leaf's document). */
  document: Document;
  /** Initial draft model (empty 3×3 for a fresh insert, or a block's model). */
  model: DiagramModel;
  /** Preferred top-left of the overlay, in viewport (fixed) coordinates. */
  anchor: { x: number; y: number };
  /** Renders a LaTeX label to an HTML element (MathJax via renderMath). */
  renderLabel: LabelRenderer;
  /** Fired on commit with the (trimmed) committed model; or null if the draft
   *  was entirely empty (§7.4: no empty block is written). */
  onCommit: (model: DiagramModel | null) => void;
  /** Fired when the user explicitly discards. */
  onDiscard: () => void;
  /** Default arrow style for newly drawn arrows. */
  defaultHead?: ArrowHead;
  defaultLineStyle?: LineStyle;
  /** Whether to show the live draft-preview pane beneath the grid (§8.3). */
  showPreview?: boolean;
  /** Initial presentation mode (feature #1); defaults to "float". The user can
   *  switch live via the mode toggle icon in the chrome. */
  mode?: EditorMode;
  /** The existing diagram's SVG to track in embedded mode (feature #1): the
   *  de-chromed editor follows this element on scroll, so it stays glued to the
   *  diagram's spot in the page. The SVG is hidden while the editor is embedded
   *  over it and restored on close / switch-to-float. Omit for a fresh insert
   *  (nothing to track → embedded de-chromes but stays fixed at the cursor). */
  followTarget?: SVGElement;
}

const HEADS: ArrowHead[] = ["default", "epi", "hook", "mapsto", "none"];
const LINES: LineStyle[] = ["solid", "dashed", "dotted"];
const LABEL_POSITIONS: LabelPosition[] = ["left", "right", "above", "below"];
const PREVIEW_DEBOUNCE_MS = 250;

/** Minimum grid size we'll let the user shrink to via row/col delete. */
const MIN_DIM = 1;

/**
 * Inline SVG icons for the mode toggle (feature #1). Each is the icon for the
 * mode you'll switch *to*: the "dock into page" glyph when floating (click → go
 * embedded), the "pop out window" glyph when embedded (click → go float). 16×16,
 * currentColor so it tracks the theme.
 */
const ICON_EMBEDDED =
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<rect x="1.5" y="1.5" width="13" height="13" rx="2"/>` +
  `<path d="M4 8h8"/>` +
  `<path d="M8 4v8"/>` +
  `</svg>`;
const ICON_FLOAT =
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/>` +
  `<path d="M2.5 6.5h11"/>` +
  `<circle cx="4.4" cy="5" r="0.4" fill="currentColor" stroke="none"/>` +
  `<circle cx="6" cy="5" r="0.4" fill="currentColor" stroke="none"/>` +
  `</svg>`;

export class GridEditor {
  private readonly doc: Document;
  private readonly anchor: { x: number; y: number };
  private readonly defaultHead: ArrowHead;
  private readonly defaultLineStyle: LineStyle;
  private readonly showPreview: boolean;
  private readonly renderLabel: LabelRenderer;
  private readonly onCommit: (model: DiagramModel | null) => void;
  private readonly onDiscard: () => void;

  /** Current presentation mode (feature #1); switchable at runtime. */
  private mode: EditorMode;
  /** The diagram SVG embedded mode tracks (feature #1): the de-chromed editor
   *  follows it on scroll so it stays at the diagram's spot in the page. Hidden
   *  while embedded, restored on close / switch-to-float. Null for a fresh
   *  insert (nothing to track). */
  private readonly followTarget: SVGElement | null;
  /** The wrapper around `followTarget` (e.g. `.cd-diagram-wrap`) — a full-width
   *  block whose box spans the reading column. Embedded mode follows THIS (not
   *  the narrow SVG) so the editor's width aligns with the page, and hides it so
   *  the static diagram + its edit button don't show through. */
  private followHost: HTMLElement | null = null;
  /** The rAF id of the scroll-follow loop (embedded mode), cleared on unmode. */
  private followRaf = 0;
  /** Observes the grid's box so the in-grid arrows re-render when it resizes
   *  (feature #2: arrows follow the resize) — covers resize-drag, window
   *  resize, and any other layout change. rAF-throttled to coalesce callbacks. */
  private resizeObserver: ResizeObserver | null = null;
  private arrowRerenderRaf = 0;

  private root: HTMLDivElement;
  private gridEl: HTMLDivElement;
  private previewEl: HTMLDivElement;
  private propertiesEl: HTMLDivElement | null = null;
  /**
   * User-set viewport position for the arrow properties popover, when they've
   * dragged it off the default corner. Viewport (not overlay-relative) coords,
   * because the popover is mounted in document.body and can float outside the
   * editor window (improvement #3). Cleared in closeProperties so a freshly
   * opened panel starts at the default position again.
   */
  private propertiesOffset: { left: number; top: number } | null = null;
  /** A chrome popover (Import/Export), anchored to its trigger button. Only one
   *  is open at a time; toggling its trigger closes the other. */
  private chromePopover: HTMLDivElement | null = null;
  /** Undo / Redo chrome buttons (refreshed via refreshHistoryButtons). */
  private undoBtn: HTMLButtonElement | null = null;
  private redoBtn: HTMLButtonElement | null = null;
  /** Mode toggle button (float ⇄ embedded), feature #1. */
  private modeBtn: HTMLButtonElement | null = null;

  private model: DiagramModel;
  private selectedArrowId: string | null = null;
  private editingCell: { row: number; col: number } | null = null;
  /** The gridcell that currently holds roving-tabindex focus (§7.3 a11y). */
  private focusedCell: { row: number; col: number } | null = null;
  private previewTimer: number | null = null;

  /** Undo/redo history of committed model states (improvement #1). `past`
   *  holds states older than the current `model`; `future` holds states newer
   *  than it (populated by undo, cleared by any new edit). `model` itself is
   *  always the current, visible state — history stores one entry per logical
   *  change, so dragging the curve handle (many patches) is one entry. */
  private past: DiagramModel[] = [];
  private future: DiagramModel[] = [];
  private static readonly MAX_HISTORY = 100;
  /** Render-generation guard: only the latest renderPreview call appends its
   *  SVG, so two overlapping async renders can't both draw (which produced a
   *  doubled preview when committing a cell and then drawing an arrow fired
   *  renderPreview back-to-back before the first await resolved). */
  private previewGeneration = 0;
  private closed = false;

  private boundOutsidePointer: (e: PointerEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(opts: GridEditorOptions) {
    this.doc = opts.document;
    this.renderLabel = opts.renderLabel;
    this.onCommit = opts.onCommit;
    this.onDiscard = opts.onDiscard;
    this.model = cloneModel(opts.model);
    // The initial model is the baseline: there's nothing to undo back past it.
    this.past = [];
    this.future = [];
    this.anchor = opts.anchor;
    this.defaultHead = opts.defaultHead ?? "default";
    this.defaultLineStyle = opts.defaultLineStyle ?? "solid";
    this.showPreview = opts.showPreview !== false;
    this.mode = opts.mode ?? "float";
    this.followTarget = opts.followTarget ?? null;

    this.root = this.doc.createElement("div");
    this.root.className = "cd-editor-overlay";
    this.applyModeClass();
    this.gridEl = this.doc.createElement("div");
    this.gridEl.className = "cd-editor-grid";
    this.gridEl.setAttribute("role", "grid");
    this.gridEl.setAttribute("aria-label", "Commutative diagram grid");
    this.previewEl = this.doc.createElement("div");
    this.previewEl.className = "cd-editor-preview";

    this.boundOutsidePointer = this.onOutsidePointer.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
  }

  /** Mount the overlay and focus it. */
  mount(): void {
    this.buildChrome();
    // The root is the positioning/resize shell (no overflow, so the negative-
    // offset resize handles render outside its box). Scrollable content lives in
    // an inner wrapper — otherwise overflow:auto on the root would clip the
    // handles and the shadows of body-mounted popovers.
    const body = this.doc.createElement("div");
    body.className = "cd-editor-body";
    body.appendChild(this.gridEl);
    if (this.showPreview) {
      const previewWrap = this.doc.createElement("div");
      previewWrap.className = "cd-editor-preview-wrap";
      previewWrap.appendChild(this.previewEl);
      body.appendChild(previewWrap);
    }
    this.root.appendChild(body);
    this.doc.body.appendChild(this.root);

    this.position();
    // Resize handles are a float-window affordance; skip them when the editor
    // opens in embedded mode (toggleMode re-adds them if the user switches).
    if (this.mode === "float") this.attachResizeHandles();
    if (this.mode === "embedded") this.startFollow();
    this.renderGrid();
    if (this.showPreview) this.renderPreview();
    this.attachResizeObserver();

    // §7.3 a11y: seed roving focus on the top-left cell so keyboard users land
    // somewhere meaningful on open (don't steal focus from a cell input that
    // the user might be actively typing in — we only seed when nothing is
    // being edited, which is always the case at mount).
    if (!this.focusedCell) this.focusedCell = { row: 0, col: 0 };
    this.restoreCellFocus();

    // Capture-phase outside-pointer handler so we commit before a click on an
    // underlying element takes effect. We must ignore presses inside our root
    // (including a cell input → another cell input; §7.4).
    this.doc.addEventListener("pointerdown", this.boundOutsidePointer, true);
    this.doc.addEventListener("keydown", this.boundKeyDown, true);

    // Reflect the empty initial history in the Undo/Redo buttons.
    this.refreshHistoryButtons();
  }

  /** Detach the overlay and remove all listeners. Safe to call once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPreviewDebounce();
    this.stopFollow();
    this.detachResizeObserver();
    this.closeChromePopover();
    // The properties popover is mounted in document.body (so it can be dragged
    // outside the editor); remove it explicitly since root.remove() won't.
    this.closeProperties();
    this.doc.removeEventListener("pointerdown", this.boundOutsidePointer, true);
    this.doc.removeEventListener("keydown", this.boundKeyDown, true);
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Layout / chrome
  // -------------------------------------------------------------------------

  private buildChrome(): void {
    const chrome = this.doc.createElement("div");
    chrome.className = "cd-editor-chrome";

    // The title bar is the drag handle for moving the window (§7.2: user can
    // reposition the overlay). Dragging updates the fixed left/top.
    const title = this.doc.createElement("span");
    title.className = "cd-editor-title";
    title.textContent = "Commutative diagram";
    chrome.appendChild(title);
    this.makeDragHandle(chrome);

    const actions = this.doc.createElement("div");
    actions.className = "cd-editor-actions";

    // Undo / redo (improvement #1): step the model history. Ctrl/Cmd+Z and
    // Ctrl/Cmd+Shift+Z (or Ctrl+Y) are the keyboard equivalents (onKeyDown).
    // Both are disabled when their stack is empty; the disabled state is
    // refreshed via refreshHistoryButtons() after every change.
    const undoBtn = this.doc.createElement("button");
    undoBtn.type = "button";
    undoBtn.textContent = "Undo";
    undoBtn.className = "cd-editor-chrome-btn cd-editor-undo";
    undoBtn.title = "Undo (Ctrl/Cmd+Z)";
    undoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.undo();
    });
    actions.appendChild(undoBtn);

    const redoBtn = this.doc.createElement("button");
    redoBtn.type = "button";
    redoBtn.textContent = "Redo";
    redoBtn.className = "cd-editor-chrome-btn cd-editor-redo";
    redoBtn.title = "Redo (Ctrl/Cmd+Shift+Z)";
    redoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.redo();
    });
    actions.appendChild(redoBtn);

    this.undoBtn = undoBtn;
    this.redoBtn = redoBtn;

    // Mode toggle (feature #1): an icon button that switches between the
    // floating window and the de-chromed, scroll-following embedded view. The
    // icon shown is the mode you'll switch TO (so it reads as "go there").
    const modeBtn = this.doc.createElement("button");
    modeBtn.type = "button";
    modeBtn.className = "cd-editor-chrome-btn cd-editor-mode cd-editor-icon-btn";
    modeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMode();
    });
    actions.appendChild(modeBtn);
    this.modeBtn = modeBtn;
    this.refreshModeIcon();

    // Import (§9): paste a tikz-cd or AMS CD block to replace the draft.
    const importBtn = this.doc.createElement("button");
    importBtn.type = "button";
    importBtn.textContent = "Import";
    importBtn.className = "cd-editor-chrome-btn cd-editor-import";
    importBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleImportPopover(importBtn);
    });
    actions.appendChild(importBtn);

    // Export (§9): emit the draft as tikz-cd or AMS CD.
    const exportBtn = this.doc.createElement("button");
    exportBtn.type = "button";
    exportBtn.textContent = "Export";
    exportBtn.className = "cd-editor-chrome-btn cd-editor-export";
    exportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleExportPopover(exportBtn);
    });
    actions.appendChild(exportBtn);

    const discard = this.doc.createElement("button");
    discard.type = "button";
    discard.textContent = "Discard";
    discard.className = "cd-editor-discard";
    discard.addEventListener("click", (e) => {
      e.stopPropagation();
      this.discard();
    });
    actions.appendChild(discard);
    chrome.appendChild(actions);

    this.root.appendChild(chrome);
  }

  /** Make `handle` a drag handle that moves the overlay. */
  private makeDragHandle(handle: HTMLElement): void {
    handle.addClass("cd-drag-handle");
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.addEventListener("pointerdown", (e) => {
      // Don't start a drag from the Discard button.
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.root.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      handle.addClass("is-dragging");
      e.preventDefault();
    });

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const left = originLeft + (e.clientX - startX);
      const top = originTop + (e.clientY - startY);
      this.root.style.left = `${left}px`;
      this.root.style.top = `${top}px`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.removeClass("is-dragging");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /**
   * Attach resize handles to the four edges and four corners of the editor
   * overlay (improvement #2). Dragging an edge adjusts width OR height; a
   * corner adjusts both. The overlay is position:fixed, so resizing is a direct
   * mutation of root.style.width/height (and left/top when dragging a
   * top/left-anchored handle, so the opposite edge stays put). Uses fixed pixel
   * sizes rather than vw/vh once the user starts resizing, so the overlay stops
   * tracking the viewport and stays the size they set.
   */
  private attachResizeHandles(): void {
    const MIN_W = 320;
    const MIN_H = 200;
    const edges: { dir: string; cursor: string }[] = [
      { dir: "n", cursor: "ns-resize" },
      { dir: "s", cursor: "ns-resize" },
      { dir: "e", cursor: "ew-resize" },
      { dir: "w", cursor: "ew-resize" },
      { dir: "ne", cursor: "nesw-resize" },
      { dir: "nw", cursor: "nwse-resize" },
      { dir: "se", cursor: "nwse-resize" },
      { dir: "sw", cursor: "nesw-resize" },
    ];
    for (const edge of edges) {
      const handle = this.doc.createElement("div");
      handle.className = `cd-resize-handle cd-resize-${edge.dir}`;
      handle.style.cursor = edge.cursor;
      handle.addEventListener("pointerdown", (e) => this.beginResize(e, edge.dir, MIN_W, MIN_H));
      this.root.appendChild(handle);
    }
  }

  /** Begin a resize drag for the given edge/corner direction. */
  private beginResize(e: PointerEvent, dir: string, minW: number, minH: number): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = this.root.getBoundingClientRect();

    // Pin the current size/position in pixels so subsequent style writes are
    // absolute (independent of the viewport-relative defaults in styles.css).
    this.root.style.width = `${rect.width}px`;
    this.root.style.height = `${rect.height}px`;
    this.root.style.left = `${rect.left}px`;
    this.root.style.top = `${rect.top}px`;

    const n = dir.includes("n");
    const s = dir.includes("s");
    const w = dir.includes("w");
    const east = dir.includes("e");

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let width = rect.width;
      let height = rect.height;
      let left = rect.left;
      let top = rect.top;
      if (east) width = Math.max(minW, rect.width + dx);
      if (s) height = Math.max(minH, rect.height + dy);
      if (w) {
        width = Math.max(minW, rect.width - dx);
        left = rect.left + (rect.width - width);
      }
      if (n) {
        height = Math.max(minH, rect.height - dy);
        top = rect.top + (rect.height - height);
      }
      this.root.style.width = `${width}px`;
      this.root.style.height = `${height}px`;
      this.root.style.left = `${left}px`;
      this.root.style.top = `${top}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private position(): void {
    const rect = this.root.getBoundingClientRect();
    const { left, top } = placeNear(this.anchor.x, this.anchor.y, rect.width, rect.height);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  /** Toggle between the float-window and embedded (de-chromed, scroll-following)
   *  presentation (feature #1). Embedded mode tracks the diagram's element so
   *  the grid scrolls with the page; float mode is a fixed popup. */
  private toggleMode(): void {
    this.mode = this.mode === "float" ? "embedded" : "float";
    this.applyModeClass();
    // Clear any pixel sizing/position pinned by a previous resize/follow so the
    // new mode's CSS sizing takes effect cleanly.
    this.root.style.width = "";
    this.root.style.height = "";
    // Resize handles are float-window only; scroll-follow is embedded only.
    if (this.mode === "float") {
      this.stopFollow();
      this.attachResizeHandles();
      this.position();
    } else {
      this.removeResizeHandles();
      this.startFollow();
    }
    // A mode change can shift the grid's box; re-measure arrows + preview.
    this.renderGridArrows();
    if (this.showPreview) this.renderPreview();
    this.refreshModeIcon();
  }

  /** Update the mode toggle icon + tooltip to reflect the current mode. */
  private refreshModeIcon(): void {
    if (!this.modeBtn) return;
    this.modeBtn.innerHTML =
      this.mode === "float" ? ICON_EMBEDDED : ICON_FLOAT;
    this.modeBtn.title =
      this.mode === "float"
        ? "Switch to embedded view (grid sits in the page, scrolls with it)"
        : "Switch to floating window";
    this.modeBtn.setAttribute(
      "aria-label",
      this.mode === "float" ? "Embedded view" : "Floating window",
    );
  }

  /** Apply (or clear) the embedded-mode class on the root. Idempotent. */
  private applyModeClass(): void {
    if (this.mode === "embedded") this.root.addClass("cd-editor-embedded");
    else this.root.removeClass("cd-editor-embedded");
  }

  /** Remove all resize handles (used when switching to embedded mode). */
  private removeResizeHandles(): void {
    const handles = this.root.querySelectorAll<HTMLElement>(".cd-resize-handle");
    for (const h of Array.from(handles)) h.remove();
  }

  /**
   * Watch the grid's box and re-render the in-grid arrows whenever it changes
   * (feature #2: arrows follow the resize). Arrow endpoints are computed from
   * each cell's `getBoundingClientRect`, so they go stale whenever a resize
   * (drag handle, window/pane resize, mode switch, viewport zoom) changes cell
   * sizes — without this, the shafts keep their old pixel positions while the
   * cells move. Callbacks are rAF-throttled to coalesce a burst of resize
   * events into one redraw.
   */
  private attachResizeObserver(): void {
    this.detachResizeObserver();
    const RO = this.doc.defaultView?.ResizeObserver;
    if (!RO) return;
    this.resizeObserver = new RO(() => {
      if (this.closed) return;
      if (this.arrowRerenderRaf) return; // already scheduled
      this.arrowRerenderRaf = this.doc.defaultView?.requestAnimationFrame(() => {
        this.arrowRerenderRaf = 0;
        if (this.closed) return;
        this.renderGridArrows();
      }) ?? 0;
    });
    this.resizeObserver.observe(this.gridEl);
  }

  private detachResizeObserver(): void {
    if (this.arrowRerenderRaf) {
      this.doc.defaultView?.cancelAnimationFrame(this.arrowRerenderRaf);
      this.arrowRerenderRaf = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  // -------------------------------------------------------------------------
  // Embedded scroll-follow (feature #1)
  //
  // In embedded mode the de-chromed editor tracks the existing diagram's SVG:
  // a rAF loop reads its viewport rect each frame and pins the editor's
  // left/top/width to it, so the grid scrolls with the page exactly where the
  // diagram was. The static SVG is hidden while embedded so the two don't
  // overlap, and restored when we leave embedded mode or close.
  // -------------------------------------------------------------------------

  /** Begin tracking the diagram (embedded mode). The editor follows the SVG's
   *  full-width wrapper so its width aligns with the page column; no-op without
   *  a target. */
  private startFollow(): void {
    this.stopFollow();
    if (!this.followTarget) return;
    // The wrapper (`.cd-diagram-wrap` / `.cd-lp-wrap`) is a full-width block —
    // the reading column — so following it aligns the editor to the page. The
    // SVG itself is only as wide as its content, far narrower than the column.
    this.followHost = this.followTarget.closest<HTMLElement>(".cd-diagram-wrap, .cd-lp-wrap")
      ?? this.followTarget.parentElement;
    const hideTarget = this.followHost ?? this.followTarget;
    hideTarget.addClass("cd-embedded-hidden");
    this.followRaf = this.doc.defaultView?.requestAnimationFrame(() => this.followLoop()) ?? 0;
  }

  /** rAF body: position the editor over the target, then schedule the next. */
  private followLoop(): void {
    if (this.closed || this.mode !== "embedded" || !this.followTarget) return;
    this.updateFollowPosition();
    this.followRaf = this.doc.defaultView?.requestAnimationFrame(() => this.followLoop()) ?? 0;
  }

  /** Snap the editor's fixed position + width to the tracked element's rect. */
  private updateFollowPosition(): void {
    const target = this.followHost ?? this.followTarget;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    // Position: update every frame so the editor tracks the diagram on scroll.
    this.root.style.left = `${rect.left}px`;
    this.root.style.top = `${rect.top}px`;
    // Width: the host spans the reading column — aligning the editor to it
    // makes the embedded grid match the page width. Only rewrite when it
    // actually changes (e.g. window/pane resize) to avoid per-frame thrash;
    // re-render the in-grid arrows then so the shafts track the new column.
    const w = Math.max(rect.width, 0);
    const cur = parseFloat(this.root.style.width);
    if (!Number.isFinite(cur) || Math.abs(cur - w) > 0.5) {
      this.root.style.width = `${w}px`;
      this.renderGridArrows();
    }
  }

  /** Stop tracking and reveal the static diagram again (switch-to-float / close). */
  private stopFollow(): void {
    if (this.followRaf) {
      this.doc.defaultView?.cancelAnimationFrame(this.followRaf);
      this.followRaf = 0;
    }
    const hideTarget = this.followHost ?? this.followTarget;
    hideTarget?.removeClass("cd-embedded-hidden");
    this.followHost = null;
  }

  // -------------------------------------------------------------------------
  // Import / Export popovers (§9)
  //
  // Two small popovers anchored under the Import / Export chrome buttons.
  // Import: a textarea + a format toggle (tikz-cd / AMS CD) + an "Import"
  // button that parses the pasted source and replaces the draft. Export: a
  // format toggle (tikz-cd / AMS CD) that shows the emitted source in a
  // read-only textarea with a Copy button. AMS-CD export is gated by §9's
  // canExportToCD — when the draft isn't CD-expressible the option is disabled
  // with an explanatory note.
  // -------------------------------------------------------------------------

  /** Close any open chrome popover. */
  private closeChromePopover(): void {
    this.chromePopover?.remove();
    this.chromePopover = null;
  }

  /** Open a chrome popover anchored below `trigger`, closing any other first. */
  private openChromePopover(trigger: HTMLElement, build: (pop: HTMLDivElement) => void): void {
    this.closeChromePopover();
    const pop = this.doc.createElement("div");
    pop.className = "cd-chrome-popover";
    build(pop);
    this.root.appendChild(pop);
    this.chromePopover = pop;
    this.positionChromePopover(trigger, pop);
  }

  /** Place a chrome popover just below its trigger button, clamped to root. */
  private positionChromePopover(trigger: HTMLElement, pop: HTMLDivElement): void {
    const rootRect = this.root.getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(t.left - rootRect.left, rootRect.width - pop.offsetWidth - 8));
    const top = t.bottom - rootRect.top + 4;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  /** Toggle the Import popover open/closed. */
  private toggleImportPopover(trigger: HTMLElement): void {
    if (this.chromePopover?.classList.contains("cd-import-popover")) {
      this.closeChromePopover();
      return;
    }
    this.openChromePopover(trigger, (pop) => {
      pop.addClass("cd-import-popover");
      const title = this.doc.createElement("div");
      title.className = "cd-popover-title";
      title.textContent = "Import";
      pop.appendChild(title);

      const format = this.doc.createElement("select");
      for (const f of ["tikz-cd", "AMS CD"]) {
        const o = this.doc.createElement("option");
        o.value = f;
        o.textContent = f;
        format.appendChild(o);
      }
      pop.appendChild(format);

      const ta = this.doc.createElement("textarea");
      ta.className = "cd-popover-textarea";
      ta.spellcheck = false;
      ta.placeholder = "Paste a tikz-cd or \\begin{CD}…\\end{CD} block here";
      pop.appendChild(ta);

      const status = this.doc.createElement("div");
      status.className = "cd-popover-status";
      pop.appendChild(status);

      const importBtn = this.doc.createElement("button");
      importBtn.type = "button";
      importBtn.textContent = "Import into editor";
      importBtn.className = "cd-popover-action";
      importBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const src = ta.value;
        if (src.trim() === "") {
          status.textContent = "Paste a block first.";
          return;
        }
        try {
          const model = format.value === "tikz-cd" ? fromTikzcd(src) : fromCD(src);
          if (model.cells.length === 0 && model.arrows.length === 0) {
            status.textContent = "Nothing recognizable — check the format.";
            return;
          }
          this.commitModel(model);
          this.selectedArrowId = null;
          this.closeProperties();
          this.closeChromePopover();
          this.rerenderAll();
        } catch (err) {
          status.textContent = `Could not parse: ${(err as Error).message}`;
        }
      });
      pop.appendChild(importBtn);

      // Auto-focus the textarea when the popover opens.
      requestAnimationFrame(() => ta.focus());
    });
  }

  /** Toggle the Export popover open/closed. */
  private toggleExportPopover(trigger: HTMLElement): void {
    if (this.chromePopover?.classList.contains("cd-export-popover")) {
      this.closeChromePopover();
      return;
    }
    this.openChromePopover(trigger, (pop) => {
      pop.addClass("cd-export-popover");
      const title = this.doc.createElement("div");
      title.className = "cd-popover-title";
      title.textContent = "Export";
      pop.appendChild(title);

      const format = this.doc.createElement("select");
      const tikzOpt = this.doc.createElement("option");
      tikzOpt.value = "tikz-cd";
      tikzOpt.textContent = "tikz-cd";
      const cdOpt = this.doc.createElement("option");
      cdOpt.value = "AMS CD";
      cdOpt.textContent = "AMS CD";
      format.appendChild(tikzOpt);
      format.appendChild(cdOpt);
      pop.appendChild(format);

      const ta = this.doc.createElement("textarea");
      ta.className = "cd-popover-textarea";
      ta.spellcheck = false;
      ta.readOnly = true;
      pop.appendChild(ta);

      const status = this.doc.createElement("div");
      status.className = "cd-popover-status";
      pop.appendChild(status);

      const copyBtn = this.doc.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "Copy";
      copyBtn.className = "cd-popover-action";
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await this.doc.defaultView?.navigator.clipboard.writeText(ta.value);
          status.textContent = "Copied to clipboard.";
        } catch {
          status.textContent = "Copy failed — select the text and copy manually.";
        }
      });
      pop.appendChild(copyBtn);

      const render = () => {
        status.textContent = "";
        if (format.value === "tikz-cd") {
          ta.value = toTikzcd(this.model);
          ta.disabled = false;
          copyBtn.disabled = false;
        } else {
          const reason = canExportToCD(this.model);
          if (reason) {
            // §9 gating: not CD-expressible — show why, disable copy.
            ta.value = "";
            ta.disabled = true;
            copyBtn.disabled = true;
            status.textContent = reason;
          } else {
            ta.value = toCD(this.model);
            ta.disabled = false;
            copyBtn.disabled = false;
          }
        }
      };
      format.addEventListener("change", render);
      render();
    });
  }

  // -------------------------------------------------------------------------
  // Grid rendering
  // -------------------------------------------------------------------------

  private renderGrid(): void {
    this.gridEl.innerHTML = "";
    this.gridEl.style.gridTemplateColumns = `repeat(${this.model.cols}, 1fr)`;
    this.gridEl.style.gridTemplateRows = `repeat(${this.model.rows}, 1fr)`;

    for (let r = 0; r < this.model.rows; r++) {
      for (let c = 0; c < this.model.cols; c++) {
        this.gridEl.appendChild(this.buildCell(r, c));
      }
    }

    // Add-row / add-column controls.
    const addRow = this.makeAddButton("cd-add-row", "+ row", () => {
      this.commitModel(appendRow(this.model));
      this.rerenderAll();
    });
    const addCol = this.makeAddButton("cd-add-col", "+ col", () => {
      this.commitModel(appendCol(this.model));
      this.rerenderAll();
    });
    this.gridEl.appendChild(addRow);
    this.gridEl.appendChild(addCol);

    // Per-row / per-col remove controls (only shown when not destructive, per
    // §7.3: warn rather than silently destroy — here we hide the control if
    // deleting would remove content, so the user can't accidentally nuke it).
    this.attachRemoveControls();

    // Draw the model's arrows directly on the grid (in-grid live feedback).
    this.renderGridArrows();

    // §7.3 a11y: restore roving-tabindex focus after a full grid rebuild.
    this.restoreCellFocus();
  }

  private buildCell(row: number, col: number): HTMLDivElement {
    const cell = this.doc.createElement("div");
    cell.className = "cd-cell";
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    // §7.3 accessibility: cells are keyboard-focusable grid cells. tabindex
    // -1 (focusable programmatically / via arrow keys, not in the natural Tab
    // order); the grid uses roving tabindex — exactly one cell holds tabindex
    // 0 at a time (the "focused" cell), set in restoreCellFocus.
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("tabindex", "-1");
    const label = getLabel(this.model, row, col);
    if (label.trim() === "") {
      cell.addClass("is-empty");
      cell.setAttribute("aria-label", `Empty cell row ${row + 1} column ${col + 1}`);
    } else {
      cell.setAttribute("aria-label", `Cell row ${row + 1} column ${col + 1}: ${label}`);
    }

    // Label display (preview while not editing).
    const labelEl = this.doc.createElement("div");
    labelEl.className = "cd-cell-label";
    cell.appendChild(labelEl);
    this.renderCellLabel(labelEl, label);

    // Drag handle band (§7.3). Always pointer-active: a press that turns into
    // a drag draws an arrow; a press that releases in place edits the label.
    const band = this.doc.createElement("div");
    band.className = "cd-cell-drag-band";
    cell.appendChild(band);

    // Unified press-drag-release on the band: distinguish a click (edit) from
    // a drag (draw arrow) by a movement threshold. §7.3 wants editing text and
    // drawing arrows to not fight over the same press; an active input keeps
    // its own pointer events, so this only fires when not editing this cell.
    band.addEventListener("pointerdown", (e) => {
      if (this.editingCell && this.editingCell.row === row && this.editingCell.col === col) {
        return; // let the input handle the press
      }
      e.preventDefault();
      e.stopPropagation();
      this.beginPress(row, col, e);
    });

    // Keyboard: when a cell is focused (not being edited — the input owns its
    // own keys), Enter/Space open the label editor and arrow keys move focus
    // to the neighbor cell (§7.3 accessibility pass).
    cell.addEventListener("keydown", (e) => {
      if (this.editingCell) return; // input handles keys while editing
      switch (e.key) {
        case "Enter":
        case " ":
          e.preventDefault();
          e.stopPropagation();
          this.startEditing(row, col);
          break;
        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight":
          e.preventDefault();
          e.stopPropagation();
          this.moveFocusArrow(row, col, e.key);
          break;
      }
    });

    return cell;
  }

  private async renderCellLabel(host: HTMLElement, latex: string): Promise<void> {
    host.empty();
    if (latex.trim() === "") return;
    try {
      host.appendChild(this.renderLabel(latex));
    } catch {
      const span = this.doc.createElement("span");
      span.textContent = latex;
      host.appendChild(span);
    }
  }

  private makeAddButton(cls: string, text: string, onClick: () => void): HTMLDivElement {
    const btn = this.doc.createElement("div");
    btn.className = `cd-add-btn ${cls}`;
    btn.textContent = text;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  /** Attach small remove (–) buttons to each row/column header area. Buttons
   *  that would perform a destructive delete are hidden (§7.3). */
  private attachRemoveControls(): void {
    for (let r = 0; r < this.model.rows; r++) {
      if (this.model.rows <= MIN_DIM) break;
      if (rowDeletionIsDestructive(this.model, r)) continue;
      const btn = this.makeRemoveButton("cd-row-remove", "–", () => {
        this.commitModel(deleteRow(this.model, r));
        this.rerenderAll();
      });
      // position at the left edge of the row's first cell
      btn.addClass("cd-row-header");
      const cell = this.gridEl.querySelector<HTMLDivElement>(
        `.cd-cell[data-row="${r}"][data-col="0"]`,
      );
      if (cell) cell.appendChild(btn);
    }
    for (let c = 0; c < this.model.cols; c++) {
      if (this.model.cols <= MIN_DIM) break;
      if (colDeletionIsDestructive(this.model, c)) continue;
      const btn = this.makeRemoveButton("cd-col-remove", "–", () => {
        this.commitModel(deleteCol(this.model, c));
        this.rerenderAll();
      });
      btn.addClass("cd-col-header");
      const cell = this.gridEl.querySelector<HTMLDivElement>(
        `.cd-cell[data-row="0"][data-col="${c}"]`,
      );
      if (cell) cell.appendChild(btn);
    }
  }

  private makeRemoveButton(cls: string, text: string, onClick: () => void): HTMLButtonElement {
    const btn = this.doc.createElement("button");
    btn.type = "button";
    btn.className = `cd-remove-btn ${cls}`;
    btn.textContent = text;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // -------------------------------------------------------------------------
  // Cell label editing
  // -------------------------------------------------------------------------

  private startEditing(row: number, col: number): void {
    if (this.editingCell) this.commitCellEdit();
    this.editingCell = { row, col };
    this.focusedCell = { row, col };
    this.selectedArrowId = null;
    this.closeProperties();

    const cell = this.gridEl.querySelector<HTMLDivElement>(
      `.cd-cell[data-row="${row}"][data-col="${col}"]`,
    );
    if (!cell) return;
    cell.addClass("is-focused");

    const input = this.doc.createElement("input");
    input.type = "text";
    input.className = "cd-cell-input";
    input.value = getLabel(this.model, row, col);
    input.spellcheck = false;
    cell.appendChild(input);
    input.focus();
    input.select();

    const preview = this.doc.createElement("div");
    preview.className = "cd-cell-preview";
    cell.appendChild(preview);

    const onInput = () => this.scheduleCellPreview(preview, input.value);
    input.addEventListener("input", onInput);
    input.addEventListener("blur", () => this.commitCellEdit());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.commitCellEdit();
      } else if (e.key === "Escape") {
        // Stop the global Escape (commit) from firing — here Escape cancels
        // the cell edit only, matching inline-edit conventions.
        e.stopPropagation();
        this.cancelCellEdit();
      } else if (e.key === "Tab") {
        e.preventDefault();
        this.commitCellEdit();
        this.moveFocus(row, col, e.shiftKey ? -1 : 1);
      }
    });
  }

  private scheduleCellPreview(host: HTMLElement, latex: string): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.renderCellLabel(host, latex);
    }, PREVIEW_DEBOUNCE_MS);
  }

  private commitCellEdit(): void {
    if (!this.editingCell) return;
    const { row, col } = this.editingCell;
    const cell = this.gridEl.querySelector<HTMLDivElement>(
      `.cd-cell[data-row="${row}"][data-col="${col}"]`,
    );
    const input = cell?.querySelector<HTMLInputElement>(".cd-cell-input");
    const value = input?.value ?? "";
    this.editingCell = null;
    this.cancelPreviewDebounce();

    this.commitModel(setCellLabel(this.model, row, col, value));
    // Keep keyboard focus on the just-edited cell after the grid rebuilds.
    this.focusedCell = { row, col };
    this.rerenderAll();
  }

  private cancelCellEdit(): void {
    if (this.editingCell) this.focusedCell = { ...this.editingCell };
    this.editingCell = null;
    this.cancelPreviewDebounce();
    this.rerenderAll();
  }

  private moveFocus(row: number, col: number, dir: 1 | -1): void {
    // Reading-order (row-major) Tab traversal, wrapping at grid bounds.
    const n = this.model.rows * this.model.cols;
    let idx = row * this.model.cols + col + dir;
    if (idx < 0) idx = n - 1;
    if (idx >= n) idx = 0;
    const nr = Math.floor(idx / this.model.cols);
    const nc = idx % this.model.cols;
    this.focusedCell = { row: nr, col: nc };
    this.startEditing(nr, nc);
  }

  /**
   * Move roving cell focus by one step in an arrow-key direction (§7.3 a11y).
   * Wraps within the grid. Does NOT open the editor — arrow keys move focus,
   * Enter/Space edit.
   */
  private moveFocusArrow(row: number, col: number, key: string): void {
    let r = row;
    let c = col;
    if (key === "ArrowUp") r = (row - 1 + this.model.rows) % this.model.rows;
    else if (key === "ArrowDown") r = (row + 1) % this.model.rows;
    else if (key === "ArrowLeft") c = (col - 1 + this.model.cols) % this.model.cols;
    else if (key === "ArrowRight") c = (col + 1) % this.model.cols;
    this.focusedCell = { row: r, col: c };
    this.focusCell(r, c);
  }

  /** Focus a cell and make it the roving-tabindex anchor. */
  private focusCell(row: number, col: number): void {
    const cell = this.gridEl.querySelector<HTMLDivElement>(
      `.cd-cell[data-row="${row}"][data-col="${col}"]`,
    );
    if (cell) {
      cell.setAttribute("tabindex", "0");
      cell.focus();
    }
  }

  /**
   * After a grid rebuild, re-establish roving-tabindex on `focusedCell` (or
   * the top-left cell). Only steals DOM focus when no cell input is currently
   * being edited, so we never yank focus out from under a typing user.
   */
  private restoreCellFocus(): void {
    const all = this.gridEl.querySelectorAll<HTMLElement>(".cd-cell");
    for (const c of Array.from(all)) c.setAttribute("tabindex", "-1");

    let target = this.focusedCell;
    if (!target || target.row >= this.model.rows || target.col >= this.model.cols) {
      target = { row: 0, col: 0 };
      this.focusedCell = target;
    }
    const cell = this.gridEl.querySelector<HTMLDivElement>(
      `.cd-cell[data-row="${target.row}"][data-col="${target.col}"]`,
    );
    if (!cell) return;
    cell.setAttribute("tabindex", "0");
    // Don't move DOM focus while the user is mid-edit in a cell input — the
    // input owns focus then. Otherwise focus the cell so keyboard navigation
    // works immediately after e.g. an add-row/col.
    if (!this.editingCell) {
      // Only refocus if the overlay itself (or a descendant) currently holds
      // focus; otherwise we'd steal focus from somewhere external on a
      // background re-render. We treat "active element is within root" as the
      // signal that focus is ours to manage.
      if (this.root.contains(this.doc.activeElement)) {
        cell.focus();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Arrow drawing (press in one cell, drag into another)
  //
  // A press on a cell's drag-band starts a pending gesture. If the pointer
  // moves past a small threshold we treat it as a drag and begin drawing an
  // arrow (a live line follows the pointer). If it releases in place (under
  // the threshold) it's a click → edit the cell's label. §7.3.
  // -------------------------------------------------------------------------

  private static DRAG_THRESHOLD = 4; // px before a press becomes a drag

  private beginPress(row: number, col: number, e: PointerEvent): void {
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let line: SVGLineElement | null = null;

    const fromCenter = this.cellCenter(row, col);

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < GridEditor.DRAG_THRESHOLD) {
          return;
        }
        dragging = true;
        line = this.startDragLine(fromCenter);
      }
      if (line) {
        const gridRect = this.gridEl.getBoundingClientRect();
        line.setAttribute("x2", String(ev.clientX - gridRect.left));
        line.setAttribute("y2", String(ev.clientY - gridRect.top));
      }
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (line) line.remove();

      if (!dragging) {
        // Click in place → edit this cell's label.
        this.startEditing(row, col);
        return;
      }
      const target = this.cellAtPoint(ev.clientX, ev.clientY);
      if (!target) return;
      if (target.row === row && target.col === col) return; // no self-arrow
      this.commitModel(addArrow(this.model, {
        from: { row, col },
        to: { row: target.row, col: target.col },
        head: this.defaultHead,
        lineStyle: this.defaultLineStyle,
      }));
      this.rerenderAll();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private startDragLine(from: { x: number; y: number }): SVGLineElement {
    const svg = this.ensureSvgLayer();
    const line = this.doc.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "cd-drag-line");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(from.x));
    line.setAttribute("y2", String(from.y));
    svg.appendChild(line);
    return line;
  }

  private ensureSvgLayer(): SVGSVGElement {
    let svg = this.gridEl.querySelector<SVGSVGElement>(".cd-svg-layer");
    if (!svg) {
      svg = this.doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "cd-svg-layer");
      this.gridEl.appendChild(svg);
    }
    return svg;
  }

  /**
   * Draw the model's arrows directly on the grid's SVG layer, between cell
   * centers (clipped to each cell's box edge so shafts don't run under
   * labels). This is the in-grid live feedback — the separate MathJax preview
   * below shows the true rendered output. Re-run on every model change.
   */
  private renderGridArrows(): void {
    const svg = this.ensureSvgLayer();
    // Clear existing arrows, but preserve an in-progress drag line.
    const dragLine = svg.querySelector<SVGLineElement>(".cd-drag-line");
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const g = this.gridEl.getBoundingClientRect();
    if (g.width === 0) {
      if (dragLine) svg.appendChild(dragLine);
      return;
    }
    svg.setAttribute("width", String(g.width));
    svg.setAttribute("height", String(g.height));

    // Group parallel arrows on the same cell pair for perpendicular offset.
    const groups = new Map<string, number[]>();
    this.model.arrows.forEach((a, i) => {
      if (a.from.row === a.to.row && a.from.col === a.to.col) return;
      const key = pairKey(a.from, a.to);
      const arr = groups.get(key);
      if (arr) arr.push(i);
      else groups.set(key, [i]);
    });

    const STEP = 10; // px perpendicular offset between parallel arrows
    groups.forEach((idxs) => {
      const n = idxs.length;
      idxs.forEach((modelIndex, k) => {
        const a = this.model.arrows[modelIndex];
        const shift = k - (n - 1) / 2;
        this.drawGridArrow(svg, a, shift * STEP);
      });
    });

    // Re-append the active drag line on top so it stays visible while drawing.
    if (dragLine) svg.appendChild(dragLine);
  }

  /** Draw a single arrow on the grid SVG layer, clickable to select it. */
  private drawGridArrow(svg: SVGSVGElement, arrow: DiagramArrow, offset: number): void {
    const c1 = this.cellCenter(arrow.from.row, arrow.from.col);
    const c2 = this.cellCenter(arrow.to.row, arrow.to.col);
    let dx = c2.x - c1.x;
    let dy = c2.y - c1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return;
    dx /= len;
    dy /= len;

    // Perpendicular offset (canonical direction so opposite arrows separate).
    const flip = comparePos(arrow.from, arrow.to) > 0;
    const cdx = flip ? -dx : dx;
    const cdy = flip ? -dy : dy;
    const ox = cdy * offset;
    const oy = -cdx * offset;

    // Clip the shaft to each ENDPOINT's *rendered label* box (plus a little
    // padding), not the whole cell. An arrow's length/direction thus follows
    // the actual distance between the two objects: a short label in a wide
    // cell yields a long arrow spanning the real gap, instead of a stub that
    // only crosses the cell boundary. Empty cells anchor near their center.
    const pad = 5;
    const s1 = this.labelHalfExtents(arrow.from.row, arrow.from.col, pad);
    const s2 = this.labelHalfExtents(arrow.to.row, arrow.to.col, pad);
    const start = clipToBox(c1.x, c1.y, dx, dy, s1.hw, s1.hh);
    const end = clipToBox(c2.x, c2.y, -dx, -dy, s2.hw, s2.hh);
    const x1 = start.x + ox;
    const y1 = start.y + oy;
    const x2 = end.x + ox;
    const y2 = end.y + oy;

    // Curve (mirrors render.ts): a quadratic Bézier bulge, curve ∈ [-1,1],
    // 0 = straight. Heads/tails attach along the tangent at each end.
    const curve = this.clampedCurve(arrow.curve);
    const chordLen = Math.hypot(x2 - x1, y2 - y1);
    let ctrlX = 0;
    let ctrlY = 0;
    let startDirX = dx;
    let startDirY = dy;
    let endDirX = dx;
    let endDirY = dy;
    let apexX = (x1 + x2) / 2;
    let apexY = (y1 + y2) / 2;
    const isCurved = curve !== 0 && chordLen > 1e-9;
    if (isCurved) {
      const perpX = dy; // perpLeft(dx,dy); curve > 0 bulges left of travel
      const perpY = -dx;
      const apexOff = curve * chordLen * CURVE_APEX_FRAC;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      ctrlX = mx + perpX * (2 * apexOff);
      ctrlY = my + perpY * (2 * apexOff);
      apexX = mx + perpX * apexOff;
      apexY = my + perpY * apexOff;
      const sd = unitOrFallback(ctrlX - x1, ctrlY - y1, dx, dy);
      startDirX = sd.x; startDirY = sd.y;
      const ed = unitOrFallback(x2 - ctrlX, y2 - ctrlY, dx, dy);
      endDirX = ed.x; endDirY = ed.y;
    }

    const g = this.doc.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "cd-arrow");
    g.setAttribute("data-arrow-id", arrow.id);
    if (this.selectedArrowId === arrow.id) g.addClass("is-selected");

    // Shaft (Bézier when curved, else a line).
    const shaft = this.doc.createElementNS("http://www.w3.org/2000/svg", "path");
    shaft.setAttribute("class", "cd-arrow-path");
    shaft.setAttribute(
      "d",
      isCurved
        ? `M ${x1} ${y1} Q ${ctrlX} ${ctrlY} ${x2} ${y2}`
        : `M ${x1} ${y1} L ${x2} ${y2}`,
    );
    if (arrow.lineStyle === "dashed") shaft.setAttribute("stroke-dasharray", "5 3");
    if (arrow.lineStyle === "dotted") shaft.setAttribute("stroke-dasharray", "1 3");
    g.appendChild(shaft);

    // Head (target end, along the end tangent) / tail decoration (start tangent).
    this.appendGridHead(g, x2, y2, endDirX, endDirY, arrow.head ?? "default");
    if (arrow.bidirectional) {
      this.appendGridHead(g, x1, y1, -startDirX, -startDirY, arrow.head === "none" ? "default" : (arrow.head ?? "default"));
    } else if (arrow.head === "mapsto") {
      this.appendGridMapstoBar(g, x1, y1, startDirX, startDirY);
    } else if (arrow.head === "hook") {
      this.appendGridHook(g, x1, y1, startDirX, startDirY);
    }

    // Invisible fat hit area for easy clicking (follows the curve).
    const hit = this.doc.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("class", "cd-arrow-hit");
    hit.setAttribute("d", isCurved ? `M ${x1} ${y1} Q ${ctrlX} ${ctrlY} ${x2} ${y2}` : `M ${x1} ${y1} L ${x2} ${y2}`);
    g.appendChild(hit);

    // Label at the curve's apex (the chord midpoint when straight).
    if (arrow.label && arrow.label.trim() !== "") {
      const labelHost = this.doc.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
      const nrm = this.labelNormal(arrow.labelPosition ?? "left", dx, dy);
      labelHost.setAttribute("x", String(apexX + nrm.x * 14 - 30));
      labelHost.setAttribute("y", String(apexY + nrm.y * 14 - 10));
      labelHost.setAttribute("width", "60");
      labelHost.setAttribute("height", "20");
      labelHost.setCssStyles({ overflow: "visible", pointerEvents: "none" });
      const inner = this.doc.createElement("div");
      inner.className = "cd-arrow-label";
      try {
        inner.appendChild(this.renderLabel(arrow.label));
      } catch {
        inner.textContent = arrow.label;
      }
      labelHost.appendChild(inner);
      g.appendChild(labelHost);
    }

    g.addEventListener("click", (e: MouseEvent) => this.onArrowClick(arrow.id, e));
    svg.appendChild(g);

    // Curve handle for the selected arrow: a draggable dot at the apex that
    // sets `curve` by perpendicular drag (§improvement: adjust curve by dragging).
    if (this.selectedArrowId === arrow.id) {
      this.drawCurveHandle(svg, arrow, x1, y1, x2, y2, dx, dy, chordLen);
    }
  }

  /** Clamp a curve value to [-1,1], treating NaN/undefined as 0 (straight). */
  private clampedCurve(curve: number | undefined): number {
    if (typeof curve !== "number" || !Number.isFinite(curve)) return 0;
    return Math.max(CURVE_MIN, Math.min(CURVE_MAX, curve));
  }

  /**
   * Draw the draggable curve handle for the selected arrow at its arc apex.
   * Dragging perpendicular to the chord sets the arrow's `curve` (−1..1); the
   * handle's screen position during the drag is the new apex, so it tracks the
   * pointer 1:1. Releasing commits the curve (0 snaps back to straight/omitted).
   */
  private drawCurveHandle(
    svg: SVGSVGElement,
    arrow: DiagramArrow,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    dx: number,
    dy: number,
    chordLen: number,
  ): void {
    if (chordLen < 1e-9) return;
    const curve = this.clampedCurve(arrow.curve);
    const perpX = dy;
    const perpY = -dx;
    const apexOff = curve * chordLen * CURVE_APEX_FRAC;
    const hx = (x1 + x2) / 2 + perpX * apexOff;
    const hy = (y1 + y2) / 2 + perpY * apexOff;

    const handle = this.doc.createElementNS("http://www.w3.org/2000/svg", "circle");
    handle.setAttribute("class", "cd-curve-handle");
    handle.setAttribute("cx", String(hx));
    handle.setAttribute("cy", String(hy));
    handle.setAttribute("r", "6");
    handle.setAttribute("role", "slider");
    handle.setAttribute("aria-label", "Curve amount");
    handle.setAttribute("aria-valuemin", String(CURVE_MIN));
    handle.setAttribute("aria-valuemax", String(CURVE_MAX));
    handle.setAttribute("aria-valuenow", String(Math.round(curve * 100) / 100));
    svg.appendChild(handle);

    // Dragging the handle sets `curve` by perpendicular drag. Listeners are
    // registered on `window` only when a drag STARTS (not on every redraw —
    // patchArrow rebuilds the handle each move, so registering at draw time
    // would leak a listener pair per move event) and removed when it ends.
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      let dragging = true;
      const onMove = (ev: PointerEvent) => {
        if (!dragging) return;
        ev.stopPropagation();
        const gridRect = this.gridEl.getBoundingClientRect();
        const px = ev.clientX - gridRect.left;
        const py = ev.clientY - gridRect.top;
        // Project the pointer onto the perpendicular axis through the chord
        // midpoint; that signed distance, as a fraction of the apex range, is
        // the new curve. The apex range for curve=±1 is ±chordLen*CURVE_APEX_FRAC.
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const along = (px - mx) * perpX + (py - my) * perpY;
        const c = Math.max(CURVE_MIN, Math.min(CURVE_MAX, along / (chordLen * CURVE_APEX_FRAC)));
        // Skip the MathJax preview per-move; refresh once on release for smoothness.
        this.patchArrow(arrow.id, { curve: c }, { preview: false });
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (this.showPreview) this.renderPreview();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  private appendGridHead(g: SVGGElement, tipX: number, tipY: number, dx: number, dy: number, head: ArrowHead): void {
    if (head === "none") return;
    const len = 9;
    const half = 4;
    const draw = (tx: number, ty: number) => {
      const bx = tx - dx * len;
      const by = ty - dy * len;
      const px = dy;
      const py = -dx;
      const p = this.doc.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("class", "cd-arrow-path");
      p.setAttribute("d", `M ${bx + px * half} ${by + py * half} L ${tx} ${ty} L ${bx - px * half} ${by - py * half}`);
      g.appendChild(p);
    };
    draw(tipX, tipY);
    if (head === "epi") draw(tipX - dx * len * 0.8, tipY - dy * len * 0.8);
  }

  private appendGridMapstoBar(g: SVGGElement, x: number, y: number, dx: number, dy: number): void {
    const px = dy;
    const py = -dx;
    const half = 5;
    const p = this.doc.createElementNS("http://www.w3.org/2000/svg", "line");
    p.setAttribute("class", "cd-arrow-path");
    p.setAttribute("x1", String(x + px * half));
    p.setAttribute("y1", String(y + py * half));
    p.setAttribute("x2", String(x - px * half));
    p.setAttribute("y2", String(y - py * half));
    g.appendChild(p);
  }

  private appendGridHook(g: SVGGElement, x: number, y: number, dx: number, dy: number): void {
    // Mirror render.ts's hook: start perpendicular to the tail (start→tail ⊥
    // shaft), control behind the tail on the shaft line (end-tangent = shaft
    // dir, no kink). h is larger than the head so the curl reads as a hook.
    const px = dy;
    const py = -dx;
    const h = 9;
    const sx = x + px * h;
    const sy = y + py * h;
    const cx = x - dx * h;
    const cy = y - dy * h;
    const p = this.doc.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("class", "cd-arrow-path");
    p.setAttribute("d", `M ${sx} ${sy} Q ${cx} ${cy} ${x} ${y}`);
    g.appendChild(p);
  }

  private cellCenter(row: number, col: number): { x: number; y: number } {
    const cell = this.gridEl.querySelector<HTMLElement>(
      `.cd-cell[data-row="${row}"][data-col="${col}"]`,
    );
    const g = this.gridEl.getBoundingClientRect();
    const c = cell?.getBoundingClientRect() ?? g;
    return { x: c.left - g.left + c.width / 2, y: c.top - g.top + c.height / 2 };
  }

  /**
   * Half-extents (plus padding) of a cell's *rendered label* for arrow-edge
   * clipping. Falls back to a tiny box for empty cells so an arrow anchors near
   * the cell center rather than the (much larger) cell boundary.
   */
  private labelHalfExtents(row: number, col: number, pad: number): { hw: number; hh: number } {
    const cell = this.gridEl.querySelector<HTMLElement>(
      `.cd-cell[data-row="${row}"][data-col="${col}"]`,
    );
    const label = cell?.querySelector<HTMLElement>(".cd-cell-label");
    if (label) {
      const r = label.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { hw: r.width / 2 + pad, hh: r.height / 2 + pad };
      }
    }
    return { hw: pad, hh: pad };
  }

  private cellAtPoint(x: number, y: number): { row: number; col: number } | null {
    const el = this.doc.elementFromPoint(x, y);
    if (!el) return null;
    const cell = el.closest<HTMLElement>(".cd-cell");
    if (!cell || !this.gridEl.contains(cell)) return null;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
    return { row, col };
  }

  private labelNormal(pos: LabelPosition, dx: number, dy: number): { x: number; y: number } {
    const left = { x: dy, y: -dx };
    const right = { x: -dy, y: dx };
    if (pos === "left") return left;
    if (pos === "right") return right;
    if (pos === "above") return left.y <= right.y ? left : right;
    return left.y >= right.y ? left : right; // below
  }

  // -------------------------------------------------------------------------
  // Arrow selection + properties popover
  // -------------------------------------------------------------------------

  private onArrowClick(arrowId: string, e: MouseEvent): void {
    e.stopPropagation();
    if (this.editingCell) this.commitCellEdit();
    // If the user is clicking a DIFFERENT arrow than the one whose panel is
    // open, drop the previous drag offset so the new panel opens at the default
    // corner rather than inheriting the old arrow's dragged position. Keep the
    // offset when re-selecting the same arrow (the rerenderAll that follows
    // preserves the user's placement).
    if (this.selectedArrowId !== arrowId) this.propertiesOffset = null;
    const prevSelected = this.selectedArrowId;
    this.selectedArrowId = arrowId;
    this.openProperties(arrowId);
    // Redraw the in-grid arrows so the selection highlight + curve handle move
    // to the newly clicked arrow (a click alone changes no model state, so
    // renderGridArrows wouldn't otherwise fire). Only needed when the selection
    // actually changed.
    if (prevSelected !== arrowId) this.renderGridArrows();
  }

  private openProperties(arrowId: string): void {
    this.closeProperties();
    const arrow = this.model.arrows.find((a) => a.id === arrowId);
    if (!arrow) return;

    const pop = this.doc.createElement("div");
    pop.className = "cd-properties";
    this.propertiesEl = pop;

    // Draggable header (§improvement): grab the panel by its title bar to move
    // it anywhere — including outside the editor overlay (improvement #3). The
    // panel is mounted to document.body, so it can float over the whole window.
    // The drag remembers a viewport-relative offset that survives the
    // rerenderAll() that fires on every field change, so editing a field
    // doesn't snap the panel back to its default corner.
    const header = this.doc.createElement("div");
    header.className = "cd-properties-header";
    const headerTitle = this.doc.createElement("span");
    headerTitle.className = "cd-properties-title";
    headerTitle.textContent = "Arrow";
    header.appendChild(headerTitle);
    // Close button (improvement #4): dismisses the popover without touching the
    // selection-derived data. We keep selectedArrowId cleared so the in-grid
    // highlight + curve handle leave with it.
    const closeBtn = this.doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cd-properties-close";
    closeBtn.setAttribute("aria-label", "Close arrow settings");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectedArrowId = null;
      this.closeProperties();
      this.renderGridArrows();
    });
    header.appendChild(closeBtn);
    pop.appendChild(header);
    this.makePropertiesDraggable(header, pop);

    const addField = (label: string, input: HTMLElement) => {
      const wrap = this.doc.createElement("label");
      const lab = this.doc.createElement("span");
      lab.textContent = label;
      wrap.appendChild(lab);
      wrap.appendChild(input);
      pop.appendChild(wrap);
    };

    // Label text
    const labelInput = this.doc.createElement("input");
    labelInput.type = "text";
    labelInput.value = arrow.label ?? "";
    labelInput.spellcheck = false;
    labelInput.addEventListener("input", () => {
      this.patchArrow(arrowId, { label: labelInput.value });
    });
    addField("Label", labelInput);

    // Label position
    const posSelect = this.doc.createElement("select");
    for (const p of LABEL_POSITIONS) {
      const o = this.doc.createElement("option");
      o.value = p;
      o.textContent = p;
      if ((arrow.labelPosition ?? "left") === p) o.selected = true;
      posSelect.appendChild(o);
    }
    posSelect.addEventListener("change", () => {
      this.patchArrow(arrowId, { labelPosition: posSelect.value as LabelPosition });
    });
    addField("Label position", posSelect);

    // Head style
    const headSelect = this.doc.createElement("select");
    for (const h of HEADS) {
      const o = this.doc.createElement("option");
      o.value = h;
      o.textContent = h;
      if ((arrow.head ?? "default") === h) o.selected = true;
      headSelect.appendChild(o);
    }
    headSelect.addEventListener("change", () => {
      this.patchArrow(arrowId, { head: headSelect.value as ArrowHead });
    });
    addField("Head", headSelect);

    // Line style
    const lineSelect = this.doc.createElement("select");
    for (const l of LINES) {
      const o = this.doc.createElement("option");
      o.value = l;
      o.textContent = l;
      if ((arrow.lineStyle ?? "solid") === l) o.selected = true;
      lineSelect.appendChild(o);
    }
    lineSelect.addEventListener("change", () => {
      this.patchArrow(arrowId, { lineStyle: lineSelect.value as LineStyle });
    });
    addField("Line style", lineSelect);

    // Bidirectional toggle
    const biRow = this.doc.createElement("div");
    biRow.className = "cd-prop-row";
    const biCheck = this.doc.createElement("input");
    biCheck.type = "checkbox";
    biCheck.checked = arrow.bidirectional === true;
    const biLabel = this.doc.createElement("span");
    biLabel.textContent = "Bidirectional (<->)";
    biRow.appendChild(biCheck);
    biRow.appendChild(biLabel);
    biCheck.addEventListener("change", () => {
      this.patchArrow(arrowId, { bidirectional: biCheck.checked });
    });
    pop.appendChild(biRow);

    // Curve slider (−1..1): a precise alternative to dragging the on-arrow
    // curve handle. 0 = straight; + bulges left of travel, − right (matching
    // tikz-cd's bend left/right). A "Straighten" button resets it to 0.
    const curveRow = this.doc.createElement("div");
    curveRow.className = "cd-prop-row cd-curve-row";
    const curveLabel = this.doc.createElement("span");
    curveLabel.textContent = "Curve";
    const curveSlider = this.doc.createElement("input");
    curveSlider.type = "range";
    curveSlider.min = String(CURVE_MIN);
    curveSlider.max = String(CURVE_MAX);
    curveSlider.step = "0.05";
    const initialCurve = this.clampedCurve(arrow.curve);
    curveSlider.value = String(initialCurve);
    curveSlider.setAttribute("aria-label", "Curve amount");
    const curveValue = this.doc.createElement("span");
    curveValue.className = "cd-curve-value";
    curveValue.textContent = fmtCurve(initialCurve);
    curveSlider.addEventListener("input", () => {
      const c = this.clampedCurve(Number(curveSlider.value));
      curveValue.textContent = fmtCurve(c);
      this.patchArrow(arrowId, { curve: c });
    });
    curveRow.appendChild(curveLabel);
    curveRow.appendChild(curveSlider);
    curveRow.appendChild(curveValue);
    pop.appendChild(curveRow);

    const straightenBtn = this.doc.createElement("button");
    straightenBtn.type = "button";
    straightenBtn.textContent = "Straighten";
    straightenBtn.className = "cd-curve-straighten";
    straightenBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      curveSlider.value = "0";
      curveValue.textContent = fmtCurve(0);
      this.patchArrow(arrowId, { curve: 0 });
    });
    pop.appendChild(straightenBtn);

    // Delete
    const delBtn = this.doc.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete arrow";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.commitModel(removeArrow(this.model, arrowId));
      this.selectedArrowId = null;
      this.closeProperties();
      this.rerenderAll();
    });
    pop.appendChild(delBtn);

    // Mount to document.body (not the overlay root) so the panel can be dragged
    // outside the editor window (improvement #3). It's position:fixed, so its
    // left/top are viewport coordinates, independent of the overlay.
    this.doc.body.appendChild(pop);
    this.positionProperties();
  }

  private positionProperties(): void {
    if (!this.propertiesEl) return;
    const popRect = this.propertiesEl.getBoundingClientRect();
    const vw = this.doc.defaultView?.innerWidth ?? window.innerWidth;
    const vh = this.doc.defaultView?.innerHeight ?? window.innerHeight;
    // If the user has dragged the panel, keep it where they put it (clamped to
    // stay on screen — at least one header-width visible so it can be grabbed
    // again). Otherwise default it to the bottom-right corner of the editor
    // overlay, so it appears near the diagram on first open.
    if (this.propertiesOffset) {
      const left = clampViewport(this.propertiesOffset.left, popRect.width, vw);
      const top = clampViewport(this.propertiesOffset.top, popRect.height, vh);
      this.propertiesEl.style.left = `${left}px`;
      this.propertiesEl.style.top = `${top}px`;
      return;
    }
    const rootRect = this.root.getBoundingClientRect();
    const left = clampViewport(rootRect.right - popRect.width - 12, popRect.width, vw);
    const top = clampViewport(rootRect.bottom - popRect.height - 12, popRect.height, vh);
    this.propertiesEl.style.left = `${left}px`;
    this.propertiesEl.style.top = `${top}px`;
  }

  private closeProperties(): void {
    this.propertiesEl?.remove();
    this.propertiesEl = null;
    // Clear the remembered drag offset so the next-opened panel starts at the
    // default corner rather than wherever the last one was dragged.
    this.propertiesOffset = null;
  }

  /**
   * Make `handle` drag `panel` anywhere on screen (improvement #3). The panel
   * lives in document.body and is position:fixed, so dragging sets viewport
   * left/top directly. The pointer is clamped to keep at least a header-strip
   * of the panel on screen (so it can never be dragged entirely off-window and
   * lost). The final position is recorded in `propertiesOffset` so a
   * rerenderAll() (fired on every field edit) preserves it.
   */
  private makePropertiesDraggable(handle: HTMLElement, panel: HTMLElement): void {
    handle.addClass("cd-drag-handle");
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.addEventListener("pointerdown", (e) => {
      // Don't start a drag from the close button or other interactive controls.
      if (e.target instanceof HTMLElement && e.target.closest("button,input,select,label")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      handle.addClass("is-dragging");
      e.preventDefault();
      e.stopPropagation();
    });

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const popRect = panel.getBoundingClientRect();
      const vw = this.doc.defaultView?.innerWidth ?? window.innerWidth;
      const vh = this.doc.defaultView?.innerHeight ?? window.innerHeight;
      let left = originLeft + (e.clientX - startX);
      let top = originTop + (e.clientY - startY);
      left = clampViewport(left, popRect.width, vw);
      top = clampViewport(top, popRect.height, vh);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      this.propertiesOffset = { left, top };
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.removeClass("is-dragging");
    };
    // window-level so the drag continues even if the pointer leaves the handle.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private patchArrow(id: string, patch: Partial<DiagramArrow>, opts?: { preview?: boolean }): void {
    this.commitModel(updateArrow(this.model, id, patch));
    this.renderGridArrows();
    // The MathJax preview is expensive; callers that fire many rapid patches
    // (e.g. dragging the curve handle) pass preview:false and refresh once on
    // release, so the drag stays responsive.
    if (this.showPreview && opts?.preview !== false) this.renderPreview();
  }

  // -------------------------------------------------------------------------
  // Undo / redo (improvement #1)
  // -------------------------------------------------------------------------

  /**
   * Adopt `next` as the current model, pushing the previous model onto the undo
   * stack and clearing the redo stack. Skips the history entry (but still sets
   * the model) when `next` is structurally identical to the current model, so a
   * no-op patch (e.g. setting a field to its existing value) doesn't pollute the
   * stack. Every model mutation that should be undoable goes through here.
   */
  private commitModel(next: DiagramModel): void {
    if (modelsEqual(this.model, next)) {
      this.model = next;
      return;
    }
    this.past.push(this.model);
    if (this.past.length > GridEditor.MAX_HISTORY) this.past.shift();
    this.future = [];
    this.model = next;
    this.refreshHistoryButtons();
  }

  /** Enable/disable the Undo/Redo buttons to match the current stacks. */
  private refreshHistoryButtons(): void {
    if (this.undoBtn) this.undoBtn.disabled = this.past.length === 0;
    if (this.redoBtn) this.redoBtn.disabled = this.future.length === 0;
  }

  /** Undo the last committed change; no-op if there's nothing to undo. */
  private undo(): void {
    if (this.past.length === 0) return;
    this.future.push(this.model);
    this.model = this.past.pop()!;
    this.afterHistoryRestore();
  }

  /** Redo a previously undone change; no-op if there's nothing to redo. */
  private redo(): void {
    if (this.future.length === 0) return;
    this.past.push(this.model);
    this.model = this.future.pop()!;
    this.afterHistoryRestore();
  }

  /** Refresh the grid + preview after an undo/redo, keeping the properties
   *  popover open if the selected arrow still exists. */
  private afterHistoryRestore(): void {
    // If a cell was mid-edit, drop the input — its underlying label may have
    // changed underneath it; reopening from the restored state is cleanest.
    if (this.editingCell) {
      this.editingCell = null;
      this.cancelPreviewDebounce();
    }
    this.renderGrid();
    if (this.showPreview) this.renderPreview();
    if (this.selectedArrowId && this.model.arrows.some((a) => a.id === this.selectedArrowId)) {
      this.openProperties(this.selectedArrowId);
    } else {
      this.selectedArrowId = null;
      this.closeProperties();
    }
    this.refreshHistoryButtons();
  }

  // -------------------------------------------------------------------------
  // Live preview (shared renderer)
  // -------------------------------------------------------------------------

  private async renderPreview(): Promise<void> {
    const gen = ++this.previewGeneration;
    this.previewEl.empty();
    try {
      const svg = await renderDiagramAsync(this.model, {
        document: this.doc,
        renderLabel: this.renderLabel,
      });
      // A newer render started while we awaited — drop this one.
      if (gen !== this.previewGeneration || this.closed) return;
      this.previewEl.appendChild(svg);
      this.wirePreviewArrows(svg);
    } catch {
      if (gen !== this.previewGeneration || this.closed) return;
      const span = this.doc.createElement("span");
      span.textContent = "(preview error)";
      this.previewEl.appendChild(span);
    }
  }

  /** Make arrows in the preview clickable to open the properties popover, and
   *  mark the currently-selected one (feature #2: highlight the selected arrow
   *  in the preview as well as the in-grid view). */
  private wirePreviewArrows(svg: SVGElement): void {
    const groups = Array.from(svg.querySelectorAll<SVGGElement>("g.cd-arrow"));
    for (const g of groups) {
      const id = g.getAttribute("data-arrow-id");
      if (!id) continue;
      if (this.selectedArrowId === id) g.addClass("is-selected");
      g.addEventListener("click", (e: MouseEvent) => this.onArrowClick(id, e));
    }
  }

  // -------------------------------------------------------------------------
  // Rerender orchestration
  // -------------------------------------------------------------------------

  private rerenderAll(): void {
    this.renderGrid();
    if (this.showPreview) this.renderPreview();
    // Re-open properties if an arrow is still selected and still exists. The
    // previous panel is removed first so openProperties rebuilds it from the
    // post-change model (its field handlers captured the *old* arrow, and a
    // patch can change the selected arrow's own properties).
    if (this.selectedArrowId && this.model.arrows.some((a) => a.id === this.selectedArrowId)) {
      this.closeProperties();
      this.openProperties(this.selectedArrowId);
    } else {
      this.selectedArrowId = null;
      this.closeProperties();
    }
  }

  private cancelPreviewDebounce(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Global event handlers (outside-click, Escape, scroll)
  // -------------------------------------------------------------------------

  private onOutsidePointer(e: PointerEvent): void {
    if (this.closed) return;
    // The arrow-properties popover is mounted in document.body (so it can be
    // dragged outside the editor window); a press on it is "inside" and must
    // NOT commit, just like a press on the overlay itself.
    if (this.propertiesEl?.contains(e.target as Node)) return;
    if (this.root.contains(e.target as Node)) {
      // Inside the overlay: if a chrome popover is open and the press isn't on
      // it (or its trigger button), close the popover so it doesn't dangle over
      // the grid while the user edits. Don't commit — inside-root presses never
      // do (§7.4).
      if (this.chromePopover && !this.chromePopover.contains(e.target as Node)) {
        const onTrigger = (e.target as HTMLElement).closest?.(".cd-editor-import, .cd-editor-export");
        if (!onTrigger) this.closeChromePopover();
      }
      return;
    }
    // A pointerdown outside the overlay commits (§7.4).
    this.commit();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.closed) return;
    // Undo / redo (improvement #1). Capture-phase keydown on the document, so
    // this works whether a cell, the grid, or the properties panel has focus.
    // Skip while a cell label is being edited (the input owns text-editing
    // shortcuts — and undoing mid-keystroke would yank the field's value).
    const isUndo = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z" && !e.shiftKey;
    const isRedo =
      (e.ctrlKey || e.metaKey) && !e.altKey &&
      ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y");
    if (isUndo || isRedo) {
      if (this.editingCell) return;
      e.preventDefault();
      e.stopPropagation();
      if (isUndo) this.undo();
      else this.redo();
      return;
    }
    if (e.key === "Escape") {
      // If a chrome popover (Import/Export) is open, Escape closes just that.
      if (this.chromePopover) {
        e.stopPropagation();
        this.closeChromePopover();
        return;
      }
      // If a cell is being edited or the properties popover is open, Escape
      // closes just that; otherwise Escape commits the whole editor (§7.4).
      if (this.editingCell) {
        e.stopPropagation();
        this.cancelCellEdit();
        return;
      }
      if (this.propertiesEl) {
        e.stopPropagation();
        this.closeProperties();
        this.selectedArrowId = null;
        // Clear the in-grid selection highlight + curve handle, which otherwise
        // linger until the next model change (the handle in particular is a
        // prominent dot that shouldn't outlive the selection).
        this.renderGridArrows();
        return;
      }
      e.stopPropagation();
      this.commit();
    }
  }

  // (Scroll-while-open: the plan's §13 recommended auto-close-on-scroll, but
  // in practice the live MathJax preview's offscreen measurement host can
  // synthesize scroll events that fire mid-typing and close the editor
  // unexpectedly. Dropped for v1 — outside-click / Escape / Discard cover
  // dismissal; if a user scrolls the note they can click back into the
  // diagram's "edit" button (Phase 3) to reopen.)

  // -------------------------------------------------------------------------
  // Commit / discard
  // -------------------------------------------------------------------------

  private commit(): void {
    if (this.closed) return;
    if (this.editingCell) this.commitCellEdit();
    const trimmed = trimTrailing(cloneModel(this.model));
    const isEmpty =
      trimmed.arrows.length === 0 &&
      trimmed.cells.every((c) => c.label.trim() === "");
    const result: DiagramModel | null = isEmpty ? null : trimmed;
    const cb = this.onCommit;
    this.close();
    cb(result);
  }

  private discard(): void {
    if (this.closed) return;
    const cb = this.onDiscard;
    this.close();
    cb();
  }
}

// -------------------------------------------------------------------------
// Positioning — kept local so GridEditor is self-contained; the shared
// positioning.ts handles the general viewport clamp, this wraps it with the
// overlay's measured size.
// -------------------------------------------------------------------------

import { placeInViewport, viewportRect } from "./positioning";

function placeNear(x: number, y: number, w: number, h: number): { left: number; top: number } {
  return placeInViewport(x, y, w, h, viewportRect());
}

/** Convenience for callers that want a fresh default model. */
export function freshModel(rows = 3, cols = 3): DiagramModel {
  return createEmptyModel(rows, cols);
}

export { insertRow, insertCol };

// Module-level geometry helpers for the in-grid arrow rendering.

/**
 * Structural equality for two models, used by commitModel to skip no-op
 * history entries. A normalized serialize-then-string compare would also work,
 * but this deep comparison is cheaper (no JSON round-trip) and tolerant of
 * incidental key ordering. Arrow ids are compared too — a changed id is a real
 * change (it happens on import, which replaces the model).
 */
function modelsEqual(a: DiagramModel, b: DiagramModel): boolean {
  if (a === b) return true;
  if (a.rows !== b.rows || a.cols !== b.cols) return false;
  if (a.cells.length !== b.cells.length) return false;
  if (a.arrows.length !== b.arrows.length) return false;
  for (let i = 0; i < a.cells.length; i++) {
    const ac = a.cells[i];
    const bc = b.cells[i];
    if (ac.row !== bc.row || ac.col !== bc.col || ac.label !== bc.label) return false;
  }
  for (let i = 0; i < a.arrows.length; i++) {
    const aa = a.arrows[i];
    const ba = b.arrows[i];
    if (
      aa.id !== ba.id ||
      aa.from.row !== ba.from.row || aa.from.col !== ba.from.col ||
      aa.to.row !== ba.to.row || aa.to.col !== ba.to.col ||
      (aa.label ?? "") !== (ba.label ?? "") ||
      (aa.labelPosition ?? null) !== (ba.labelPosition ?? null) ||
      (aa.head ?? null) !== (ba.head ?? null) ||
      (aa.lineStyle ?? null) !== (ba.lineStyle ?? null) ||
      aa.bidirectional === true !== ba.bidirectional === true ||
      (aa.curve ?? null) !== (ba.curve ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function comparePos(a: { row: number; col: number }, b: { row: number; col: number }): number {
  return a.row - b.row || a.col - b.col;
}

/**
 * Clamp a viewport position for a fixed panel of `size` px within a viewport of
 * `viewport` px, keeping at least 40px of the panel visible on each axis (so a
 * dragged popover can peek outside the editor but can never be lost off-screen).
 */
function clampViewport(pos: number, size: number, viewport: number): number {
  const keep = 40;
  const min = keep - size; // allow up to (size - 40)px off the left/top
  const max = viewport - keep; // keep at least 40px visible on the right/bottom
  return Math.max(min, Math.min(pos, max));
}

function pairKey(a: { row: number; col: number }, b: { row: number; col: number }): string {
  return comparePos(a, b) <= 0
    ? `${a.row},${a.col}|${b.row},${b.col}`
    : `${b.row},${b.col}|${a.row},${a.col}`;
}

function clipToBox(
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  hw: number,
  hh: number,
): { x: number; y: number } {
  const tx = Math.abs(dx) < 1e-9 ? Infinity : hw / Math.abs(dx);
  const ty = Math.abs(dy) < 1e-9 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Unit vector along (x,y), falling back to (fx,fy) when (x,y) is ~zero
 *  (degenerate Bézier tangent guard). Mirrors render.ts. */
function unitOrFallback(x: number, y: number, fx: number, fy: number): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (len < 1e-9) return { x: fx, y: fy };
  return { x: x / len, y: y / len };
}

/** Format a curve value for the properties popover: "straight", or ±n%. */
function fmtCurve(c: number): string {
  if (Math.abs(c) < 1e-9) return "straight";
  const pct = Math.round(c * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}
