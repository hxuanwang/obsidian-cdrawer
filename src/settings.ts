/**
 * src/settings.ts (§8.3 — Phase 4)
 *
 * Plugin settings + the settings-tab UI. Three knobs:
 *   - default grid size (rows × cols) for a freshly inserted diagram;
 *   - default arrow head + line style for newly drawn arrows;
 *   - whether clicking a rendered diagram opens the editor immediately, or
 *     shows a small edit affordance on hover first (the safer default, so a
 *     reader scrolling the note doesn't open the editor by accident — §8.3).
 *
 * The arrow/grid defaults are also the source of truth the GridEditor consults
 * when it draws a new arrow or builds a fresh model, so changing them here
 * changes editor behavior live without a reload.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type CommutativeDiagramPlugin from "./main";
import { DEFAULT_HEAD, DEFAULT_LINE, type ArrowHead, type LineStyle } from "./diagram/model";
import type { EditorMode } from "./editor/GridEditor";

export interface CDSettings {
  /** Default rows for a fresh diagram. */
  defaultRows: number;
  /** Default cols for a fresh diagram. */
  defaultCols: number;
  /** Default arrow head style for newly drawn arrows. */
  defaultHead: ArrowHead;
  /** Default arrow line style for newly drawn arrows. */
  defaultLineStyle: LineStyle;
  /**
   * If false (the safer default), a rendered diagram only opens the editor via
   * a small edit button that appears on hover; if true, clicking anywhere on
   * the diagram opens the editor immediately (§8.3).
   */
  clickToEdit: boolean;
  /**
   * Whether the grid editor shows the live draft-preview pane beneath the grid
   * (the rendered-this-is-what-you'll-commit view). On by default; turn off for
   * a more compact editor.
   */
  showPreview: boolean;
  /**
   * Initial presentation mode for the grid editor (feature #1):
   *   - "float"    : a draggable, resizable window (the original behavior).
   *   - "embedded" : the grid sits de-chromed in the page, not a popup.
   * The user can still switch live via the mode toggle in the editor chrome.
   */
  editorMode: EditorMode;
}

export const DEFAULT_SETTINGS: CDSettings = {
  defaultRows: 3,
  defaultCols: 3,
  defaultHead: DEFAULT_HEAD,
  defaultLineStyle: DEFAULT_LINE,
  clickToEdit: false,
  showPreview: true,
  editorMode: "float",
};

const HEADS: { value: ArrowHead; label: string }[] = [
  { value: "default", label: "Default (→)" },
  { value: "epi", label: "Epi / two-head (↠)" },
  { value: "hook", label: "Hook (↪)" },
  { value: "mapsto", label: "Mapsto (↦)" },
  { value: "none", label: "None (plain line)" },
];

const LINES: { value: LineStyle; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

const MIN_DIM = 1;
const MAX_DIM = 20;

export class CDSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CommutativeDiagramPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default grid size")
      .setDesc("Rows and columns for a freshly inserted diagram (1–20).")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_DIM);
        text.inputEl.max = String(MAX_DIM);
        text.setValue(String(this.plugin.settings.defaultRows));
        text.onChange(async (v) => {
          const n = clampInt(v, this.plugin.settings.defaultRows);
          this.plugin.settings.defaultRows = n;
          await this.plugin.saveSettings();
        });
        text.inputEl.setCssStyles({ width: "5em" });
        return text;
      })
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_DIM);
        text.inputEl.max = String(MAX_DIM);
        text.setPlaceholder("cols");
        text.setValue(String(this.plugin.settings.defaultCols));
        text.onChange(async (v) => {
          const n = clampInt(v, this.plugin.settings.defaultCols);
          this.plugin.settings.defaultCols = n;
          await this.plugin.saveSettings();
        });
        text.inputEl.setCssStyles({ width: "5em" });
        return text;
      });

    new Setting(containerEl)
      .setName("Default arrow head")
      .setDesc("Head style applied to newly drawn arrows.")
      .addDropdown((dd) => {
        for (const h of HEADS) dd.addOption(h.value, h.label);
        dd.setValue(this.plugin.settings.defaultHead);
        dd.onChange(async (v) => {
          this.plugin.settings.defaultHead = v as ArrowHead;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Default arrow line style")
      .setDesc("Line style applied to newly drawn arrows.")
      .addDropdown((dd) => {
        for (const l of LINES) dd.addOption(l.value, l.label);
        dd.setValue(this.plugin.settings.defaultLineStyle);
        dd.onChange(async (v) => {
          this.plugin.settings.defaultLineStyle = v as LineStyle;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Click to edit diagrams")
      .setDesc(
        "On: clicking anywhere on a rendered diagram opens the editor. " +
          "Off (default): an edit button appears on hover instead — safer while reading.",
      )
      .addToggle((t) => {
        t.setValue(this.plugin.settings.clickToEdit);
        t.onChange(async (v) => {
          this.plugin.settings.clickToEdit = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show editor preview")
      .setDesc(
        "Show the live rendered preview beneath the grid editor " +
          "(what you see is what you commit). On by default.",
      )
      .addToggle((t) => {
        t.setValue(this.plugin.settings.showPreview);
        t.onChange(async (v) => {
          this.plugin.settings.showPreview = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Editor mode")
      .setDesc(
        "How the grid editor first opens. Floating window: a draggable, " +
          "resizable popup. Embedded: the grid sits de-chromed in the page, " +
          "without a window border. You can still switch modes with the toggle " +
          "in the editor's top bar.",
      )
      .addDropdown((dd) => {
        dd.addOption("float", "Floating window");
        dd.addOption("embedded", "Embedded in page");
        dd.setValue(this.plugin.settings.editorMode);
        dd.onChange(async (v) => {
          this.plugin.settings.editorMode = v as EditorMode;
          await this.plugin.saveSettings();
        });
      });
  }
}

function clampInt(raw: string, fallback: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_DIM, Math.min(MAX_DIM, n));
}
