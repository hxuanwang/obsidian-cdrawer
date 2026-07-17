/**
 * src/view/edit-affordance.ts (§8.3 — Phase 4)
 *
 * Shared logic for how a *rendered* diagram announces that clicking it opens
 * the editor. Two modes, selected by the `clickToEdit` setting (§8.3):
 *
 *   - clickToEdit === true  → clicking anywhere on the SVG opens the editor
 *     immediately (the original Phase 1–3 behavior).
 *   - clickToEdit === false → the SVG isn't directly clickable; instead a small
 *     "Edit" button appears over the diagram on hover, and only that button
 *     opens the editor. This is the safer default, so a reader scrolling the
 *     note doesn't trip the editor by accident.
 *
 * Both the Reading-view post-processor and the Live Preview widget call this
 * with the same `onEdit` callback, keeping the two display paths consistent.
 */

/** Wire up the edit affordance on a diagram wrapper element. */
export function attachEditAffordance(
  wrap: HTMLElement,
  svg: SVGElement,
  clickToEdit: boolean,
  onEdit: () => void,
): void {
  if (clickToEdit) {
    svg.style.cursor = "pointer";
    svg.addEventListener("click", (e) => {
      e.stopPropagation();
      onEdit();
    });
    return;
  }

  // Hover-to-edit: a small button shown on hover. The SVG itself stays
  // non-interactive so reading/scrolling never opens the editor.
  svg.style.cursor = "default";
  svg.style.pointerEvents = "none";

  wrap.addClass("cd-hover-edit");
  const btn = wrap.ownerDocument.createElement("button");
  btn.type = "button";
  btn.className = "cd-edit-btn";
  btn.setAttribute("aria-label", "Edit commutative diagram");
  btn.textContent = "Edit";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onEdit();
  });
  // Insert the button as the wrapper's first child so it overlays the SVG via
  // CSS (position: absolute), independent of the SVG's own structure.
  wrap.insertBefore(btn, wrap.firstChild);
}
