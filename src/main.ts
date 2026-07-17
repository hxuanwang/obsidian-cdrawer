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

import { Plugin } from "obsidian";

import { parseDiagram } from "./diagram/model";
import { renderDiagram } from "./diagram/render";
import { resetCDStyleMetricsCache } from "./diagram/cd-style-metrics";

const CD_LANGUAGE = "cd";

export default class CommutativeDiagramPlugin extends Plugin {
  onload(): void {
    // Read-only display processor (§8.1). Parsing/rendering only — no
    // click-to-edit interaction yet (that is Phase 3).
    this.registerMarkdownCodeBlockProcessor(
      CD_LANGUAGE,
      (source, el, ctx) => {
        this.renderCdBlock(source, el, ctx.sourcePath);
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
  private renderCdBlock(source: string, el: HTMLElement, _sourcePath: string): void {
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
      const svg = renderDiagram(model, { document: el.doc });
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
