/**
 * src/main.ts
 *
 * Plugin entry point.
 *
 * Phase 1 (done): read-only `cd` code-block processor for Reading view (§8.1),
 * rendering a static SVG via the shared render.ts.
 *
 * Phase 2 (this file): the floating grid editor (§7). Wired through three
 * triggers — ribbon icon, command palette, and the editor right-click menu —
 * each opening the GridEditor anchored at the cursor. On commit, the draft
 * model is serialized into a fenced `cd` block inserted at the cursor
 * (editor.replaceRange). Click-to-reedit an existing diagram is Phase 3.
 */

import { MarkdownView, Plugin, renderMath, TFile, type App, type Editor, type MarkdownFileInfo } from "obsidian";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";

import { parseDiagram, serializeDiagram, type DiagramModel } from "./diagram/model";
import { renderDiagramAsync, type LabelRenderer } from "./diagram/render";
import { resetCDStyleMetricsCache } from "./diagram/cd-style-metrics";
import { GridEditor, freshModel } from "./editor/GridEditor";
import { cdLivePreviewExtension } from "./view/live-preview";
import { attachEditAffordance } from "./view/edit-affordance";
import { CDSettingTab, DEFAULT_SETTINGS, type CDSettings } from "./settings";

const CD_LANGUAGE = "cd";
const FENCE = "```";

/** A live grid editor instance, tracked so we never mount two at once. */
let activeEditor: GridEditor | null = null;

export default class CommutativeDiagramPlugin extends Plugin {
  settings: CDSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    // --- Phase 1 + Phase 3: display processor (§8.1) with click-to-reedit ---
    this.registerMarkdownCodeBlockProcessor(
      CD_LANGUAGE,
      async (source, el, ctx) => {
        await this.renderCdBlock(source, el, ctx);
      },
    );

    // Drop cached style metrics on theme change (§6.4).
    this.registerEvent(this.app.workspace.on("css-change", () => {
      resetCDStyleMetricsCache();
    }));

    // --- Phase 3: Live Preview display (§8.2) ---
    // A CM6 ViewPlugin that replaces each ```cd fenced block with a static
    // SVG widget (render-only). Clicking the widget opens the same floating
    // grid editor as Reading view; on commit we dispatch a CM6 transaction
    // replacing the block's text range, so undo/redo/sync stay correct.
    this.registerEditorExtension(cdLivePreviewExtension({
      renderLabel: makeLabelRenderer(activeWindow().document),
      getClickToEdit: () => this.settings.clickToEdit,
      onEdit: (view, block, model) => this.onEditLivePreview(view, block, model),
    }));

    // --- Phase 4: settings tab (§8.3) ---
    this.addSettingTab(new CDSettingTab(this.app, this));

    // --- Phase 2: triggers (§7.1) ---
    this.addRibbonIcon("grid", "Insert commutative diagram", () => {
      this.openEditorForActiveLeaf();
    });

    this.addCommand({
      id: "insert-commutative-diagram",
      name: "Insert commutative diagram",
      editorCallback: (editor: Editor, _view: MarkdownView | MarkdownFileInfo) => {
        this.openEditor(editor);
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        menu.addItem((item) => {
          item.setTitle("Insert commutative diagram")
            .setIcon("grid")
            .onClick(() => this.openEditor(editor));
        });
      }),
    );
  }

  /** Open the editor for whichever markdown editor is currently focused. */
  private openEditorForActiveLeaf(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    this.openEditor(view.editor);
  }

  /**
   * Mount the grid editor anchored at the current cursor. On commit, write the
   * serialized `cd` block at the cursor (§7.4); on discard, do nothing.
   */
  private openEditor(editor: Editor): void {
    if (activeEditor) {
      activeEditor.close();
      activeEditor = null;
    }

    const anchor = this.cursorAnchor(editor);
    const cursor = editor.getCursor();

    activeEditor = new GridEditor({
      document: activeDocument(this.app),
      model: freshModel(this.settings.defaultRows, this.settings.defaultCols),
      anchor,
      renderLabel: makeLabelRenderer(activeDocument(this.app)),
      defaultHead: this.settings.defaultHead,
      defaultLineStyle: this.settings.defaultLineStyle,
      showPreview: this.settings.showPreview,
      onCommit: (model: DiagramModel | null) => {
        activeEditor = null;
        if (!model) return; // empty draft → write nothing (§7.4)
        const block = serializeDiagram(model);
        const fenced = `${FENCE}${CD_LANGUAGE}\n${block}\n${FENCE}\n`;
        editor.replaceRange(fenced, cursor);
      },
      onDiscard: () => {
        activeEditor = null;
      },
    });
    activeEditor.mount();
  }

  /**
   * Pixel coordinates of the cursor, for anchoring the overlay (§7.2). The
   * Obsidian Editor wraps a CodeMirror 6 EditorView; `coordsAtPos` lives on
   * that view, reached via the (untyped) `editor.cm` property.
   */
  private cursorAnchor(editor: Editor): { x: number; y: number } {
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    const cursor = editor.getCursor();
    if (cm) {
      const pos = editor.posToOffset ? editor.posToOffset(cursor) : -1;
      try {
        const rect = cm.coordsAtPos?.(pos);
        if (rect) return { x: rect.left, y: rect.bottom + 4 };
      } catch {
        // fall through to a sensible default
      }
    }
    // Fallback: near the top-left of the viewport, a little inset.
    return { x: 120, y: 160 };
  }

  // -------------------------------------------------------------------------
  // Phase 1: read-only block rendering
  // -------------------------------------------------------------------------

  private async renderCdBlock(
    source: string,
    el: HTMLElement,
    ctx: { sourcePath: string; getSectionInfo?: (el: HTMLElement) => { lineStart: number; lineEnd: number } | null },
  ): Promise<void> {
    el.addClass("cd-diagram-wrap");
    el.empty();

    let model: DiagramModel;
    try {
      model = parseDiagram(source);
    } catch (err) {
      const msg = el.createEl("div", {
        cls: "cd-error",
        text: `cd: ${(err as Error).message}`,
      });
      msg.setAttribute("role", "alert");
      return;
    }

    let svg: SVGElement | null = null;
    try {
      svg = await renderDiagramAsync(model, {
        document: el.doc,
        // §4: labels are raw LaTeX rendered via Obsidian's built-in MathJax
        // (renderMath from the `obsidian` module), not plain text. Without this
        // \phi / X^{n} render literally instead of as math glyphs.
        renderLabel: makeLabelRenderer(el.doc),
      });
      el.appendChild(svg);
    } catch (err) {
      const msg = el.createEl("div", {
        cls: "cd-error",
        text: `cd: render failed — ${(err as Error).message}`,
      });
      msg.setAttribute("role", "alert");
      return;
    }

    // Click-to-reedit (Phase 3, §8): clicking the rendered diagram reopens the
    // grid editor pre-filled with this block's model — no underlying JSON
    // editing, no extra button. On commit we rewrite the block's source range.
    // Phase 4 (§8.3): the click-vs-hover-to-edit affordance is shared with Live
    // Preview via attachEditAffordance, driven by the clickToEdit setting.
    const section = ctx.getSectionInfo?.(el) ?? null;
    if (svg) {
      attachEditAffordance(el, svg, this.settings.clickToEdit, () => {
        this.openEditorForExisting(model, ctx.sourcePath, section, svg);
      });
    }
  }

  /**
   * Reopen the grid editor for an existing rendered `cd` block. On commit,
   * rewrite the block's line range in the file (§8.1: getSectionInfo +
   * vault.process). If the draft is emptied, the block is removed entirely.
   */
  private openEditorForExisting(
    model: DiagramModel,
    sourcePath: string,
    section: { lineStart: number; lineEnd: number } | null,
    svg: SVGElement | null,
  ): void {
    if (activeEditor) {
      activeEditor.close();
      activeEditor = null;
    }
    const anchor = svg ? svgRectAnchor(svg) : { x: 160, y: 160 };
    const doc = activeDocument(this.app);

    activeEditor = new GridEditor({
      document: doc,
      model,
      anchor,
      renderLabel: makeLabelRenderer(doc),
      defaultHead: this.settings.defaultHead,
      defaultLineStyle: this.settings.defaultLineStyle,
      showPreview: this.settings.showPreview,
      onCommit: async (committed: DiagramModel | null) => {
        activeEditor = null;
        await this.writeBlock(sourcePath, section, committed);
      },
      onDiscard: () => {
        activeEditor = null;
      },
    });
    activeEditor.mount();
  }

  // -------------------------------------------------------------------------
  // Phase 3: Live Preview click-to-reedit (§8.2)
  // -------------------------------------------------------------------------

  /**
   * Open the grid editor for a ```cd block shown as a Live Preview widget.
   * Prefilled with `model`, anchored over the block. On commit, dispatch a CM6
   * transaction replacing the block's text range (so undo/redo/sync work); an
   * emptied draft removes the block entirely.
   */
  private onEditLivePreview(
    view: EditorView,
    block: { start: number; end: number },
    model: DiagramModel,
  ): void {
    if (activeEditor) {
      activeEditor.close();
      activeEditor = null;
    }
    // Anchor over the block's on-screen box. The widget decoration spans the
    // block's lines; measure the DOM range it occupies.
    const from = view.state.doc.line(block.start + 1).from;
    const to = view.state.doc.line(block.end + 1).to;
    const anchor = cmRangeAnchor(view, from, to);
    const doc = activeDocument(this.app);

    activeEditor = new GridEditor({
      document: doc,
      model,
      anchor,
      renderLabel: makeLabelRenderer(doc),
      defaultHead: this.settings.defaultHead,
      defaultLineStyle: this.settings.defaultLineStyle,
      showPreview: this.settings.showPreview,
      onCommit: (committed: DiagramModel | null) => {
        activeEditor = null;
        this.commitLivePreview(view, from, to, committed);
      },
      onDiscard: () => {
        activeEditor = null;
      },
    });
    activeEditor.mount();
  }

  /** Replace a Live Preview block's source range with a committed model. */
  private commitLivePreview(
    view: EditorView,
    from: number,
    to: number,
    model: DiagramModel | null,
  ): void {
    if (model === null) {
      // Empty draft: remove the block, including a trailing newline if one
      // follows so we don't leave a blank line behind.
      let removeTo = to;
      if (removeTo < view.state.doc.length) {
        const after = view.state.doc.sliceString(to, Math.min(to + 1, view.state.doc.length));
        if (after === "\n") removeTo += 1;
      }
      view.dispatch({
        changes: { from, to: removeTo, insert: "" },
        selection: EditorSelection.cursor(from),
      });
      return;
    }
    const fenced = `${FENCE}${CD_LANGUAGE}\n${serializeDiagram(model)}\n${FENCE}`;
    view.dispatch({
      changes: { from, to, insert: fenced },
      // Place the cursor just past the block so the widget re-renders and the
      // user isn't left sitting inside the (now raw) fenced region.
      selection: EditorSelection.cursor(from + fenced.length),
    });
  }

  /** Replace (or remove) a `cd` block's source range with a committed model. */
  private async writeBlock(
    sourcePath: string,
    section: { lineStart: number; lineEnd: number } | null,
    model: DiagramModel | null,
  ): Promise<void> {
    if (!section) return; // no reliable location → can't safely write back
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;
    const newBlock =
      model === null
        ? null
        : `${FENCE}${CD_LANGUAGE}\n${serializeDiagram(model)}\n${FENCE}`;
    await this.app.vault.process(file, (data: string) => {
      const lines = data.split("\n");
      const start = section.lineStart;
      const end = section.lineEnd; // inclusive
      const before = lines.slice(0, start);
      const after = lines.slice(end + 1);
      const replaced = newBlock === null ? [] : newBlock.split("\n");
      return [...before, ...replaced, ...after].join("\n");
    });
  }

  // -------------------------------------------------------------------------
  // Phase 4: settings (§8.3)
  // -------------------------------------------------------------------------

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/** The document to mount overlays into (the active leaf's container). */
function activeDocument(app: App): Document {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  return (view?.containerEl?.ownerDocument ?? activeWindow().document);
}

function activeWindow(): Window {
  return typeof window !== "undefined" ? window : (globalThis as unknown as { window: Window }).window;
}

/** Anchor point (viewport coords) for an editor reopening over a diagram. */
function svgRectAnchor(svg: SVGElement): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 6 };
}

/**
 * Anchor point (viewport coords) for an editor reopening over a Live Preview
 * block. Measure the on-screen box of the block's source range; fall back to a
 * sensible default if coordsAtPos can't resolve it.
 */
function cmRangeAnchor(view: EditorView, from: number, to: number): { x: number; y: number } {
  try {
    const a = view.coordsAtPos(from);
    const b = view.coordsAtPos(to);
    if (a) {
      const left = a.left;
      const bottom = b ? Math.max(a.bottom, b.bottom) : a.bottom;
      return { x: left, y: bottom + 6 };
    }
  } catch {
    // fall through
  }
  return { x: 160, y: 160 };
}

/**
 * Build a LabelRenderer backed by Obsidian's renderMath (MathJax). Mirrors the
 * container shape of render.ts's internal defaultLabelRenderer so the SVG
 * builder's measure/clone path works identically.
 */
function makeLabelRenderer(doc: Document): LabelRenderer {
  return (latex: string): HTMLElement => {
    const host = doc.createElement("div");
    host.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    host.className = "cd-rendered-label";
    try {
      host.appendChild(renderMath(latex, false));
    } catch {
      // Bad LaTeX snippet: show the source verbatim rather than failing the
      // whole diagram (matches render.ts's fallback policy).
      const span = doc.createElement("span");
      span.textContent = latex;
      host.appendChild(span);
    }
    return host;
  };
}
