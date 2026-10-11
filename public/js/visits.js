// Visitor log: tells the backend which page was opened and which wallet is connected, if any.
// No IP address is stored. A random id kept in this browser tells repeat visits apart.
import { api } from "./api.js";

const VISITOR_KEY = "campusfund.visitor";
const VISITOR_ID = /^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$/; // same check as backend/visits.py

const randomId = () =>
  crypto.randomUUID?.() ??
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

function visitorId() {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!VISITOR_ID.test(id ?? "")) {
      id = randomId();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return randomId(); // storage is blocked (e.g. some private windows): count this visit on its own
  }
}

function campaignIdFromUrl() {
  if (!location.pathname.startsWith("/campaign")) return null;
  const id = Number(new URLSearchParams(location.search).get("id"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Records this page view. Never blocks the page, and a failure is simply ignored. */
export function recordVisit(wallet) {
  api.recordVisit({ page: location.pathname, campaignId: campaignIdFromUrl(), wallet, visitor: visitorId() }).catch(() => {});
}
