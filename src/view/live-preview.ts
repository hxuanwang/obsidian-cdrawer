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
  WidgetType,
} from "@codemirror/view";
import { EditorState, StateField, type Range } from "@codemirror/state";

import { parseDiagram, type DiagramModel } from "../diagram/model";
import { renderDiagramAsync, type LabelRenderer } from "../diagram/render";
import { attachEditAffordance } from "./edit-affordance";

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
  /** Reads the current click-to-edit setting (§8.3); queried per widget build. */
  getClickToEdit: () => boolean;
  /**
   * Called when the user clicks a rendered diagram. The host opens the
   * floating grid editor prefilled with `model` and, on commit, rewrites the
   * block's text range via a CM6 transaction. `svg` is the rendered diagram the
   * user clicked — passed so embedded mode can track it (feature #1).
   */
  onEdit: (view: EditorView, block: CdBlock, model: DiagramModel, svg: SVGElement) => void;
  /**
   * Reports a non-fatal error from the ViewPlugin (e.g. a throw while building
   * decorations). The host surfaces it as a Notice so the note still opens
   * (raw block shown) and the user can read the cause without the dev console.
   * Optional; when omitted, errors are swallowed and the note still opens.
   */
  onError?: (message: string) => void;
}

/**
 * Build the Live Preview extension. Register the result with
 * `editorExtensions` (Obsidian's markdownPostProcessor / view plugin hook) —
 * main.ts wires this.
 */
export function cdLivePreviewExtension(opts: LivePreviewOptions) {
  // Block widgets (Decoration.replace with block: true) MUST be provided by a
  // StateField, not a ViewPlugin. CM6 throws
  //   "Block decorations may not be specified via plugins"
  // when a ViewPlugin's decorations include a block widget — because plugin
  // decorations are applied AFTER viewport computation and aren't allowed to
  // affect vertical layout. That throw escapes into Obsidian's note-load and
  // surfaces as "Failed to load note" whenever the cursor is OUTSIDE a cd
  // block on (re)open (the only time the widget is actually built). A StateField
  // provides its decorations DIRECTLY, which CM6 permits to contain block
  // widgets. This was the root cause of the reopen crash.
  return StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, opts);
    },
    update(decos, tr) {
      // The widget depends only on the document and the cursor line. Rebuild
      // when either changes; otherwise reuse the previous set (cheap).
      if (tr.docChanged || tr.selection) {
        return buildDecorations(tr.state, opts);
      }
      return decos;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * Build the decoration set for the current state: one block-replace widget per
 * ```cd block whose line range does NOT contain the cursor (while the cursor is
 * inside a block, Obsidian shows the raw source, matching its own fenced-code
 * behavior). Fully guarded: any throw falls back to Decoration.none (the raw
 * block shows, note still opens) and reports the cause via opts.onError.
 */
function buildDecorations(state: EditorState, opts: LivePreviewOptions): DecorationSet {
  try {
    const doc = state.doc;
    const head = state.selection.main.head;
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
    return Decoration.set(decos, true);
  } catch (err) {
    // Never let a decoration-build throw escape into CM6/Obsidian's note load —
    // fall back to no decorations (the raw ```cd block shows) and surface the
    // cause so it can be diagnosed.
    const msg = `cd (Live Preview): ${(err as Error)?.message || String(err)}`;
    try {
      opts.onError?.(msg);
    } catch {
      // reporting itself must never throw
    }
    return Decoration.none;
  }
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
    // Wrap the DOM wiring so a throw here can never escape into CM6's widget
    // build (which would break the note open in Live Preview).
    try {
      const placeholder = wrap.createEl("div", { cls: "cd-lp-placeholder" });
      placeholder.textContent = "···";
      wrap.appendChild(placeholder);
      void this.renderInto(wrap, placeholder, model, view);
    } catch (err) {
      const msg = wrap.createEl("div", {
        cls: "cd-error",
        text: `cd: ${(err as Error).message}`,
      });
      msg.setAttribute("role", "alert");
    }
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
    // Everything from here on is post-await DOM wiring. Wrap it so a throw
    // (e.g. the editor being torn down mid-render, or a transient DOM state)
    // can never escape as an unhandled rejection — which in Live Preview
    // surfaces as a "Failed to load note" error and blocks the whole note.
    try {
      if (!view.dom.isConnected) return; // editor gone
      placeholder.remove();
      if (svg) {
        wrap.appendChild(svg);
        // §8.3: shared click-vs-hover-to-edit affordance (same as Reading view).
        attachEditAffordance(wrap, svg, this.opts.getClickToEdit(), () => {
          if (svg) this.opts.onEdit(view, this.block, model, svg);
        });
      }
    } catch (err) {
      placeholder.remove();
      const msg = wrap.createEl("div", {
        cls: "cd-error",
        text: `cd: render failed — ${(err as Error).message}`,
      });
      msg.setAttribute("role", "alert");
    }
  }

  /** Widgets ignore DOM events by default; we handle clicks ourselves. */
  ignoreEvent(): boolean {
    return false;
  }
}
