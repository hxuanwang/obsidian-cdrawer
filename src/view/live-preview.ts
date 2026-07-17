/**
 * src/view/live-preview.ts (§8.2)
 *
 * Live Preview display for ` ```cd ` fenced blocks, as a CodeMirror 6
 * ViewPlugin + WidgetType. Display-only: the widget renders the shared static
 * SVG (render.ts) and, on click, hands control to the floating grid editor
 * described in §7 — which is NOT part of the CM6 widget's own lifecycle. It is
 * a separate overlay mounted independently, sidestepping the fiddly
 * "cursor inside vs outside the block" toggling logic an in-place editor would
 * need. On commit the host dispatches a CM6 transaction replacing the block's
 * text, so undo/redo/sync still work correctly.
 *
 * Fence detection: rather than reach into the Lezer syntax tree (which would
 * pull in an @codemirror/language dependency the build otherwise doesn't
 * bundle), we scan document lines directly for ` ```cd ` / ` ```cd` fences.
 * Markdown inside Live Preview is already tokenized by Obsidian, but a plain
 * line scan is robust enough for v1 and keeps the module self-contained. We
 * only treat a line as a fence opener/closer when the editor actually parses
 * it as code — i.e. when the cursor is NOT on a line inside the block, since
 * Live Preview shows raw source for the fenced region while the cursor is in
 * it. We handle that by skipping widget decoration for any block whose line
 * range contains the current selection head (so the user sees the raw JSON
 * while editing the block's source, matching Obsidian's own fenced-code
 * behavior).
 */

import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginValue,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, type Range } from "@codemirror/state";

import { parseDiagram, type DiagramModel } from "../diagram/model";
import { renderDiagramAsync, type LabelRenderer } from "../diagram/render";

const CD_LANGUAGE = "cd";
const FENCE = "```";

/** A line range of a single ```cd block, as document line indices. */
interface CdBlock {
  /** Line of the opening fence (0-indexed). */
  start: number;
  /** Line of the closing fence (0-indexed). */
  end: number;
}

/** Options the host passes in when constructing the extension. */
export interface LivePreviewOptions {
  /** Renders a LaTeX label to an HTML element (MathJax via renderMath). */
  renderLabel: LabelRenderer;
  /**
   * Called when the user clicks a rendered diagram. The host opens the
   * floating grid editor prefilled with `model` and, on commit, rewrites the
   * block's text range via a CM6 transaction.
   */
  onEdit: (view: EditorView, block: CdBlock, model: DiagramModel) => void;
}

/**
 * Build the Live Preview extension. Register the result with
 * `editorExtensions` (Obsidian's markdownPostProcessor / view plugin hook) —
 * main.ts wires this.
 */
export function cdLivePreviewExtension(opts: LivePreviewOptions) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet = Decoration.none;

      constructor(view: EditorView) {
        this.recompute(view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged
        ) {
          this.recompute(update.view);
        }
      }

      /** Re-scan the document for ```cd blocks and (re)build decorations. */
      recompute(view: EditorView): void {
        const doc = view.state.doc;
        const head = view.state.selection.main.head;
        const headLine = doc.lineAt(head).number - 1; // 0-indexed

        const blocks = findCdBlocks(doc);
        const decos: Range<Decoration>[] = [];
        for (const block of blocks) {
          // While the cursor sits inside the block, show raw source (Obsidian's
          // own behavior for fenced code) — skip the widget entirely.
          if (headLine >= block.start && headLine <= block.end) continue;
          decos.push(
            Decoration.replace({
              block: true,
              widget: new CdWidget(block, doc, opts),
            }).range(
              doc.line(block.start + 1).from,
              doc.line(block.end + 1).to,
            ),
          );
        }
        this.decorations = Decoration.set(decos, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Scan document lines for ` ```cd ` blocks. A block is an opening fence line
 * whose info string is exactly `cd` (optionally surrounded by whitespace),
 * followed by lines until the next ` ``` ` closer (or end of document). Handles
 * nested/indented fences conservatively: only unindented (<=3 leading spaces)
 * fences count, matching CommonMark's fenced-code rule.
 */
export function findCdBlocks(doc: EditorState["doc"]): CdBlock[] {
  const blocks: CdBlock[] = [];
  const lineCount = doc.lines;
  let i = 0;
  while (i < lineCount) {
    const line = doc.line(i + 1);
    const info = fenceInfo(line.text);
    if (info === CD_LANGUAGE) {
      // Find the matching closer.
      let end = i;
      for (let j = i + 1; j < lineCount; j++) {
        if (isFenceClose(doc.line(j + 1).text)) {
          end = j;
          break;
        }
      }
      if (end === i) end = lineCount - 1; // unterminated → close at EOF
      blocks.push({ start: i, end });
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return blocks;
}

/** If `text` is a fence opener, return its (trimmed) info string; else null. */
function fenceInfo(text: string): string | null {
  // Up to 3 leading spaces are allowed (CommonMark).
  const m = /^( {0,3})```(.*)$/.exec(text);
  if (!m) return null;
  // A closing fence has no info string; treat bare ``` as a closer, not opener.
  return m[2].trim();
}

function isFenceClose(text: string): boolean {
  const m = /^( {0,3})```\s*$/.exec(text);
  return m !== null;
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

class CdWidget extends WidgetType {
  private readonly block: CdBlock;
  private readonly source: string;
  private readonly opts: LivePreviewOptions;

  constructor(block: CdBlock, doc: EditorState["doc"], opts: LivePreviewOptions) {
    super();
    this.block = block;
    this.opts = opts;
    // Source = lines strictly between the fences.
    const startLine = doc.line(block.start + 1);
    const endLine = doc.line(block.end + 1);
    this.source = doc.sliceString(startLine.to + 1, endLine.from);
  }

  eq(other: CdWidget): boolean {
    return other.source === this.source && other.block.start === this.block.start;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cd-diagram-wrap cd-lp-wrap";
    wrap.setAttribute("data-cd-block", "true");

    // Parse synchronously to fail fast on bad JSON; render is async.
    let model: DiagramModel;
    try {
      model = parseDiagram(this.source);
    } catch (err) {
      const msg = wrap.createEl("div", {
        cls: "cd-error",
        text: `cd: ${(err as Error).message}`,
      });
      msg.setAttribute("role", "alert");
      return wrap;
    }

    // Placeholder while the SVG renders; replaced once MathJax typesets.
    const placeholder = wrap.createEl("div", { cls: "cd-lp-placeholder" });
    placeholder.textContent = "···";
    wrap.appendChild(placeholder);

    void this.renderInto(wrap, placeholder, model, view);

    return wrap;
  }

  private async renderInto(
    wrap: HTMLElement,
    placeholder: HTMLElement,
    model: DiagramModel,
    view: EditorView,
  ): Promise<void> {
    let svg: SVGElement | null = null;
    try {
      svg = await renderDiagramAsync(model, {
        document: wrap.ownerDocument,
        renderLabel: this.opts.renderLabel,
      });
    } catch (err) {
      placeholder.remove();
      const msg = wrap.createEl("div", {
        cls: "cd-error",
        text: `cd: render failed — ${(err as Error).message}`,
      });
      msg.setAttribute("role", "alert");
      return;
    }
    if (!view.dom.isConnected) return; // editor gone
    placeholder.remove();
    if (svg) {
      svg.style.cursor = "pointer";
      svg.addEventListener("click", (e) => {
        e.stopPropagation();
        this.opts.onEdit(view, this.block, model);
      });
      wrap.appendChild(svg);
    }
  }

  /** Widgets ignore DOM events by default; we handle clicks ourselves. */
  ignoreEvent(): boolean {
    return false;
  }
}
