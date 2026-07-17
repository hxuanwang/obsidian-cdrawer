/**
 * src/main.ts
 *
 * Plugin entry point. Phase 1 scope: register a read-only `cd` code-block
 * processor for Reading view (§8.1) that parses the block's JSON into a
 * DiagramModel and renders it to a static SVG via the shared render.ts.
 *
 * Click-to-edit, Live Preview (CM6), the floating grid editor, ribbon/command
 * triggers, and settings arrive in later phases — see CLAUDE.md §11. Phase 1's
 * job is to confirm the Phase 1 renderer renders correctly end-to-end in a real
 * note, gated by the §6.4 side-by-side visual check.
 */

import { Plugin, renderMath } from "obsidian";

import { parseDiagram } from "./diagram/model";
import { renderDiagramAsync, type LabelRenderer } from "./diagram/render";
import { resetCDStyleMetricsCache } from "./diagram/cd-style-metrics";

const CD_LANGUAGE = "cd";

export default class CommutativeDiagramPlugin extends Plugin {
  onload(): void {
    // Read-only display processor (§8.1). Parsing/rendering only — no
    // click-to-edit interaction yet (that is Phase 3).
    this.registerMarkdownCodeBlockProcessor(
      CD_LANGUAGE,
      async (source, el, ctx) => {
        await this.renderCdBlock(source, el, ctx.sourcePath);
      },
    );

    // Style metrics are cached per detected theme (§6.4). When the theme
    // changes, drop the cache so diagrams re-measure against the new theme's
    // native CD rendering on next render.
    this.registerEvent(this.app.workspace.on("css-change", () => {
      resetCDStyleMetricsCache();
    }));
  }

  /**
   * Parse a `cd` block's source and mount the rendered SVG into `el`.
   * Invalid JSON is surfaced inline (rather than throwing) so a malformed
   * block doesn't break the rest of the note's rendering.
   */
  private async renderCdBlock(source: string, el: HTMLElement, _sourcePath: string): Promise<void> {
    el.addClass("cd-diagram-wrap");
    el.empty();

    let model;
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

    try {
      const svg = await renderDiagramAsync(model, {
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
    }
  }
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
