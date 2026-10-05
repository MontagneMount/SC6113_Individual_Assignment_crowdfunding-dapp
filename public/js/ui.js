// Small DOM helpers. Text is always inserted with text nodes, never innerHTML,
// so user-written titles and descriptions can't inject HTML or scripts (XSS).
import { txUrl } from "./format.js";

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);

const STATUS_LABELS = { active: "Active", successful: "Funded", failed: "Not funded", withdrawn: "Paid out" };

export const statusBadge = (status) => el("span", { class: `badge badge-${status}` }, STATUS_LABELS[status] ?? status);

export function progressBar(progress) {
  const pct = Math.min(100, Math.max(0, progress * 100));
  const fill = el("div", { class: progress >= 1 ? "progress-fill complete" : "progress-fill" });
  fill.style.width = `${pct}%`;
  return el(
    "div",
    { class: "progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.floor(pct) },
    fill,
  );
}

const CATEGORY_COVERS = {
  Technology: ["💡", "tone-blue"],
  "Arts & Design": ["🎨", "tone-pink"],
  Games: ["🎲", "tone-violet"],
  Community: ["🤝", "tone-orange"],
  Sports: ["⚽", "tone-green"],
  Education: ["📚", "tone-teal"],
  Environment: ["🌱", "tone-lime"],
  Other: ["✨", "tone-slate"],
};

/** Uploaded cover image, or a colourful placeholder based on the category. */
export function cover(campaign, size = "card") {
  if (campaign.imageUrl) {
    return el("img", { class: `cover cover-${size}`, src: campaign.imageUrl, alt: "", loading: "lazy" });
  }
  const [emoji, tone] = CATEGORY_COVERS[campaign.category] ?? ["🚀", "tone-indigo"];
  return el(
    "div",
    { class: `cover cover-${size} cover-placeholder ${tone}`, "aria-hidden": "true" },
    el("span", { class: "cover-emoji" }, emoji),
  );
}

export const loading = (text = "Loading…") => el("div", { class: "loading" }, el("span", { class: "spinner" }), text);

export function emptyState(emoji, title, text, action) {
  return el(
    "div",
    { class: "empty" },
    el("div", { class: "empty-emoji" }, emoji),
    el("h3", {}, title),
    text ? el("p", {}, text) : null,
    action ?? null,
  );
}

export function setBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = busy;
}

// ---------- Notices (toasts) and the transaction tracker ----------

let stack = null;
function noticeStack() {
  stack ??= document.body.appendChild(el("div", { class: "notice-stack", "aria-live": "polite" }));
  return stack;
}

export function toast(message, type = "info", timeoutMs = 6000) {
  const icon = el("span", { class: "notice-icon", "aria-hidden": "true" }, type === "success" ? "✓" : type === "error" ? "!" : "i");
  const node = el(
    "div",
    { class: `notice notice-${type}`, role: type === "error" ? "alert" : "status" },
    icon,
    el("div", { class: "notice-body" }, el("p", {}, message)),
    el("button", { class: "notice-close", type: "button", "aria-label": "Dismiss", onclick: () => node.remove() }, "×"),
  );
  noticeStack().append(node);
  if (timeoutMs) setTimeout(() => node.remove(), timeoutMs);
  return node;
}

/** Shows a transaction's progress: waiting for MetaMask → submitted → confirmed or failed. */
export function txTracker(label) {
  const icon = el("span", { class: "spinner", "aria-hidden": "true" });
  const text = el("p", {}, "Please confirm in MetaMask…");
  const link = el("a", { class: "notice-link", target: "_blank", rel: "noopener", hidden: true }, "View on Etherscan ↗");
  const close = el("button", { class: "notice-close", type: "button", "aria-label": "Dismiss", hidden: true }, "×");
  const node = el("div", { class: "notice", role: "status" }, icon, el("div", { class: "notice-body" }, el("strong", {}, label), text, link), close);
  close.addEventListener("click", () => node.remove());
  noticeStack().append(node);

  const finish = (type, message) => {
    node.className = `notice notice-${type}`;
    icon.className = "notice-icon";
    icon.textContent = type === "success" ? "✓" : "!";
    text.textContent = message;
    close.hidden = false;
    setTimeout(() => node.remove(), type === "success" ? 8_000 : 20_000);
  };

  return {
    submitted(hash) {
      text.textContent = "Submitted. Waiting for the network to confirm (usually 10–30 seconds)…";
      link.href = txUrl(hash);
      link.hidden = false;
    },
    confirmed(blockNumber) {
      finish("success", `Confirmed in block ${blockNumber}.`);
    },
    failed(message) {
      finish("error", message);
    },
  };
}
