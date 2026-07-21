/**
 * Match a raw terminal input string against a named key. Prefers pi's own `matchesKey` (resolved from
 * pi-tui via the pinned pi package, since pi-tui is nested there, not hoisted) to stay faithful to pi's
 * key decoding; falls back to a small legacy-sequence matcher for the keys the overlays use if resolution
 * is unavailable. Memoized so resolution runs at most once. Shared by the logs viewer and the dashboard.
 */
import { createRequire } from "node:module";

let cachedMatchesKey = null;

export function matchesKey(data, keyId) {
  if (cachedMatchesKey === null) cachedMatchesKey = resolveMatchesKey();
  return cachedMatchesKey(data, keyId);
}

function resolveMatchesKey() {
  try {
    const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const tui = piRequire("@earendil-works/pi-tui");
    if (typeof tui.matchesKey === "function") return tui.matchesKey;
  } catch {
    // fall through to the local matcher
  }
  return localMatchesKey;
}

function localMatchesKey(data, keyId) {
  switch (keyId) {
    case "escape":
      return data === "\x1b";
    case "up":
      return data === "\x1b[A" || data === "\x1bOA";
    case "down":
      return data === "\x1b[B" || data === "\x1bOB";
    case "pageUp":
      return data === "\x1b[5~";
    case "pageDown":
      return data === "\x1b[6~";
    default:
      return false;
  }
}
