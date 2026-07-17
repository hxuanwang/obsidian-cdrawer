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
  type ArrowHead, type DiagramArrow, type DiagramModel, type LabelPosition, type LineStyle,
} from "../diagram/model";
import { renderDiagramAsync, type LabelRenderer } from "../diagram/render";

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
}

const HEADS: ArrowHead[] = ["default", "epi", "hook", "mapsto", "none"];
const LINES: LineStyle[] = ["solid", "dashed", "dotted"];
const LABEL_POSITIONS: LabelPosition[] = ["left", "right", "above", "below"];
const PREVIEW_DEBOUNCE_MS = 250;

/** Minimum grid size we'll let the user shrink to via row/col delete. */
const MIN_DIM = 1;

export class GridEditor {
  private readonly doc: Document;
  private readonly anchor: { x: number; y: number };
  private readonly defaultHead: ArrowHead;
  private readonly defaultLineStyle: LineStyle;
  private readonly renderLabel: LabelRenderer;
  private readonly onCommit: (model: DiagramModel | null) => void;
  private readonly onDiscard: () => void;

  private root: HTMLDivElement;
  private gridEl: HTMLDivElement;
  private previewEl: HTMLDivElement;
  private propertiesEl: HTMLDivElement | null = null;

  private model: DiagramModel;
  private selectedArrowId: string | null = null;
  private editingCell: { row: number; col: number } | null = null;
  private previewTimer: number | null = null;
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
    this.anchor = opts.anchor;
    this.defaultHead = opts.defaultHead ?? "default";
    this.defaultLineStyle = opts.defaultLineStyle ?? "solid";

    this.root = this.doc.createElement("div");
    this.root.className = "cd-editor-overlay";
    this.gridEl = this.doc.createElement("div");
    this.gridEl.className = "cd-editor-grid";
    this.previewEl = this.doc.createElement("div");
    this.previewEl.className = "cd-editor-preview";

    this.boundOutsidePointer = this.onOutsidePointer.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
  }

  /** Mount the overlay and focus it. */
  mount(): void {
    this.buildChrome();
    this.root.appendChild(this.gridEl);
    const previewWrap = this.doc.createElement("div");
    previewWrap.className = "cd-editor-preview-wrap";
    previewWrap.appendChild(this.previewEl);
    this.root.appendChild(previewWrap);
    this.doc.body.appendChild(this.root);

    this.position();
    this.renderGrid();
    this.renderPreview();

    // Capture-phase outside-pointer handler so we commit before a click on an
    // underlying element takes effect. We must ignore presses inside our root
    // (including a cell input → another cell input; §7.4).
    this.doc.addEventListener("pointerdown", this.boundOutsidePointer, true);
    this.doc.addEventListener("keydown", this.boundKeyDown, true);
  }

  /** Detach the overlay and remove all listeners. Safe to call once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPreviewDebounce();
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
    handle.style.cursor = "grab";
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
      handle.style.cursor = "grabbing";
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
      handle.style.cursor = "grab";
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
      this.model = appendRow(this.model);
      this.rerenderAll();
    });
    const addCol = this.makeAddButton("cd-add-col", "+ col", () => {
      this.model = appendCol(this.model);
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
  }

  private buildCell(row: number, col: number): HTMLDivElement {
    const cell = this.doc.createElement("div");
    cell.className = "cd-cell";
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    const label = getLabel(this.model, row, col);
    if (label.trim() === "") cell.addClass("is-empty");

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
        this.model = deleteRow(this.model, r);
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
        this.model = deleteCol(this.model, c);
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

    this.model = setCellLabel(this.model, row, col, value);
    this.rerenderAll();
  }

  private cancelCellEdit(): void {
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
    this.startEditing(nr, nc);
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
      this.model = addArrow(this.model, {
        from: { row, col },
        to: { row: target.row, col: target.col },
        head: this.defaultHead,
        lineStyle: this.defaultLineStyle,
      });
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

    const g = this.doc.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "cd-arrow");
    g.setAttribute("data-arrow-id", arrow.id);
    if (this.selectedArrowId === arrow.id) g.addClass("is-selected");
    g.style.cursor = "pointer";

    // Shaft
    const shaft = this.doc.createElementNS("http://www.w3.org/2000/svg", "line");
    shaft.setAttribute("class", "cd-arrow-path");
    shaft.setAttribute("x1", String(x1));
    shaft.setAttribute("y1", String(y1));
    shaft.setAttribute("x2", String(x2));
    shaft.setAttribute("y2", String(y2));
    if (arrow.lineStyle === "dashed") shaft.setAttribute("stroke-dasharray", "5 3");
    if (arrow.lineStyle === "dotted") shaft.setAttribute("stroke-dasharray", "1 3");
    g.appendChild(shaft);

    // Head (target end)
    this.appendGridHead(g, x2, y2, dx, dy, arrow.head ?? "default");
    if (arrow.bidirectional) {
      this.appendGridHead(g, x1, y1, -dx, -dy, arrow.head === "none" ? "default" : (arrow.head ?? "default"));
    } else if (arrow.head === "mapsto") {
      this.appendGridMapstoBar(g, x1, y1, dx, dy);
    } else if (arrow.head === "hook") {
      this.appendGridHook(g, x1, y1, dx, dy);
    }

    // Invisible fat hit area for easy clicking.
    const hit = this.doc.createElementNS("http://www.w3.org/2000/svg", "line");
    hit.setAttribute("class", "cd-arrow-hit");
    hit.setAttribute("x1", String(x1));
    hit.setAttribute("y1", String(y1));
    hit.setAttribute("x2", String(x2));
    hit.setAttribute("y2", String(y2));
    g.appendChild(hit);

    // Label
    if (arrow.label && arrow.label.trim() !== "") {
      const labelHost = this.doc.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const nrm = this.labelNormal(arrow.labelPosition ?? "left", dx, dy);
      labelHost.setAttribute("x", String(midX + nrm.x * 14 - 30));
      labelHost.setAttribute("y", String(midY + nrm.y * 14 - 10));
      labelHost.setAttribute("width", "60");
      labelHost.setAttribute("height", "20");
      labelHost.style.overflow = "visible";
      labelHost.style.pointerEvents = "none";
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
    const px = dy;
    const py = -dx;
    const h = 7;
    const p = this.doc.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("class", "cd-arrow-path");
    p.setAttribute(
      "d",
      `M ${x + px * h} ${y + py * h} Q ${x + px * h + dx * h} ${y + py * h + dy * h} ${x + dx * h} ${y + dy * h}`,
    );
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
    this.selectedArrowId = arrowId;
    this.openProperties(arrowId);
  }

  private openProperties(arrowId: string): void {
    this.closeProperties();
    const arrow = this.model.arrows.find((a) => a.id === arrowId);
    if (!arrow) return;

    const pop = this.doc.createElement("div");
    pop.className = "cd-properties";
    this.propertiesEl = pop;

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

    // Delete
    const delBtn = this.doc.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete arrow";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.model = removeArrow(this.model, arrowId);
      this.selectedArrowId = null;
      this.closeProperties();
      this.rerenderAll();
    });
    pop.appendChild(delBtn);

    this.root.appendChild(pop);
    this.positionProperties();
  }

  private positionProperties(): void {
    if (!this.propertiesEl) return;
    // Place below the grid's top-right area; clamp into the overlay.
    const rootRect = this.root.getBoundingClientRect();
    const popRect = this.propertiesEl.getBoundingClientRect();
    const left = Math.max(8, rootRect.width - popRect.width - 12);
    const top = rootRect.height - popRect.height - 12;
    this.propertiesEl.style.left = `${left}px`;
    this.propertiesEl.style.top = `${top}px`;
  }

  private closeProperties(): void {
    this.propertiesEl?.remove();
    this.propertiesEl = null;
  }

  private patchArrow(id: string, patch: Partial<DiagramArrow>): void {
    this.model = updateArrow(this.model, id, patch);
    this.renderGridArrows();
    this.renderPreview();
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

  /** Make arrows in the preview clickable to open the properties popover. */
  private wirePreviewArrows(svg: SVGElement): void {
    const groups = Array.from(svg.querySelectorAll<SVGGElement>("g.cd-arrow"));
    for (const g of groups) {
      const id = g.getAttribute("data-arrow-id");
      if (!id) continue;
      g.style.cursor = "pointer";
      g.addEventListener("click", (e: MouseEvent) => this.onArrowClick(id, e));
    }
  }

  // -------------------------------------------------------------------------
  // Rerender orchestration
  // -------------------------------------------------------------------------

  private rerenderAll(): void {
    this.renderGrid();
    this.renderPreview();
    // Re-open properties if an arrow is still selected and still exists.
    if (this.selectedArrowId && this.model.arrows.some((a) => a.id === this.selectedArrowId)) {
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
    if (this.root.contains(e.target as Node)) return;
    // A pointerdown outside the overlay commits (§7.4).
    this.commit();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.closed) return;
    if (e.key === "Escape") {
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

function comparePos(a: { row: number; col: number }, b: { row: number; col: number }): number {
  return a.row - b.row || a.col - b.col;
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
