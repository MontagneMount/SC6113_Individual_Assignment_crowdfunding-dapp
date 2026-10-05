// Form helpers shared by the "Start a campaign" page and the "Edit details" form.
import { LIMITS } from "./shared/constants.js";
import { el } from "./ui.js";

export const byteLength = (text) => new TextEncoder().encode(text).length;

/** Returns an error message for an unsuitable cover image, or null if it's fine (or missing). */
export function checkImage(file) {
  if (!file) return null;
  if (!LIMITS.imageTypes.includes(file.type)) return "Cover image must be a PNG, JPEG or WebP file.";
  if (file.size > LIMITS.imageMaxBytes) return "Cover image must be 2 MB or smaller.";
  return null;
}

/** Shows a preview of the chosen image under the file input. */
export function wireImagePreview(input, preview) {
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (preview.src) URL.revokeObjectURL(preview.src);
    if (file && !checkImage(file)) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
    } else {
      preview.removeAttribute("src");
      preview.hidden = true;
    }
  });
}

/** A labelled form field: label (+ optional counter), control, hint and any extra nodes. */
export function field(labelText, control, { counter = null, hint = null, extra = [] } = {}) {
  return el(
    "div",
    { class: "field" },
    el("div", { class: "field-row" }, el("label", { for: control.id }, labelText), counter),
    control,
    hint ? el("span", { class: "hint" }, hint) : null,
    ...extra,
  );
}

export function showError(node, message) {
  node.textContent = message ?? "";
  node.hidden = !message;
}
