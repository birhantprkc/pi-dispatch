/**
 * Pure text primitives for the admin dashboard: box-drawing frames, meters, and width-safe clipping.
 * No I/O, no clock, no process.env, no console, no pi API -- every input is a value the caller already
 * has, so these are testable with plain fixtures (asserted pure by panel.test.mjs).
 *
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): `clip` is the width gate through which
 * dashboard.ts funnels untrusted, PII-bearing `.log` bytes before framing. It strips control characters
 * so an escape sequence or a stray byte can neither crash the layout nor mis-size a row.
 */

// Custom: no box-drawing/meter primitive exists in deps -- ink/blessed/boxen are full TUI frameworks and
// this dashboard is a handful of monochrome frames, so a thin pure module is the right size (library-first).

/** Box-drawing + block glyphs. Swap to ASCII by aliasing this to `ASCII` for glyph-width-hostile terminals. */
export const GLYPHS = {
  tl: "┌", // top-left corner
  tr: "┐", // top-right corner
  bl: "└", // bottom-left corner
  br: "┘", // bottom-right corner
  h: "─", //  horizontal rule
  v: "│", //  vertical edge
  ml: "├", // left tee (section separator start)
  mr: "┤", // right tee (section separator end)
  full: "█", // filled meter cell
  empty: "░", // empty meter cell
  ellipsis: "…", // truncation marker
};

/** Parallel ASCII fallback: same keys, no glyph-width risk. Single point of substitution for `GLYPHS`. */
export const ASCII = {
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  h: "-",
  v: "|",
  ml: "+",
  mr: "+",
  full: "#",
  empty: ".",
  ellipsis: "...",
};

const MIN_WIDTH = 8;

/**
 * Truncate `line` to `w` display columns, appending an ellipsis glyph when content is cut. Control
 * characters (including escape sequences) are stripped first so untrusted input cannot crash or mis-size:
 * content is ASCII/box-drawing, so post-strip `String.length` is a safe column proxy.
 */
export function clip(line, w) {
  const width = Math.max(0, Math.trunc(w) || 0);
  // eslint-disable-next-line no-control-regex -- defensive strip of C0/C1 control chars from untrusted input
  const clean = String(line ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  if (clean.length <= width) return clean;
  if (width <= 1) return GLYPHS.ellipsis.slice(0, width);
  return clean.slice(0, width - 1) + GLYPHS.ellipsis;
}

/** `clip` to `w`, then right-pad with spaces to exactly `w` columns. */
export function pad(line, w) {
  const width = Math.max(0, Math.trunc(w) || 0);
  return clip(line, width).padEnd(width);
}

/**
 * Frame `sections` into a titled box, returning `string[]` where no line exceeds `width`. The inner
 * content width (`width - 4`) is computed once and is the single source of alignment truth: every inner
 * line is `pad`/`clip`ped to it. Below `MIN_WIDTH` the width is floored to `MIN_WIDTH` so a too-small
 * request degrades to a minimal frame rather than emitting ragged or over-width rows.
 */
export function box({ title = "", sections = [], footer, width = 40 } = {}) {
  const w = Math.max(MIN_WIDTH, Math.trunc(width) || MIN_WIDTH);
  const inner = w - 4; // "| " + content + " |"
  const lines = [];

  // Top border: `+- title -...-+`, title clipped so the border never overflows `w`.
  const titleText = title ? ` ${clip(title, Math.max(0, inner - 2))} ` : "";
  const topFill = Math.max(0, w - 2 - 1 - titleText.length); // corners + one leading `h`
  lines.push(GLYPHS.tl + GLYPHS.h + titleText + GLYPHS.h.repeat(topFill) + GLYPHS.tr);

  const framed = (text) => `${GLYPHS.v} ${pad(text, inner)} ${GLYPHS.v}`;
  const rule = () => GLYPHS.ml + GLYPHS.h.repeat(w - 2) + GLYPHS.mr;

  sections.forEach((section, i) => {
    if (i > 0) lines.push(rule());
    if (section?.title) lines.push(framed(section.title));
    for (const line of section?.lines ?? []) lines.push(framed(line));
  });

  if (footer !== undefined && footer !== null) {
    if (sections.length > 0) lines.push(rule());
    lines.push(framed(footer));
  }

  lines.push(GLYPHS.bl + GLYPHS.h.repeat(w - 2) + GLYPHS.br);
  return lines;
}

/**
 * A block-char progress bar `[####....] reserved/cap` fitted to `width`. When `cap` is not a positive
 * integer the true cap is unknown to this process, so it renders `reserved / ? (cap unknown)` with no bar
 * rather than a bar against a guessed denominator.
 */
export function meter(reserved, cap, width = 24) {
  const r = Number.isFinite(reserved) ? Math.max(0, Math.trunc(reserved)) : 0;
  if (!Number.isInteger(cap) || cap <= 0) {
    return clip(`${r} / ? (cap unknown)`, width);
  }
  const label = ` ${r}/${cap}`;
  const barCells = Math.max(0, Math.trunc(width) - label.length - 2); // "[" + cells + "]" + label
  const filled = Math.min(barCells, Math.round((Math.min(r, cap) / cap) * barCells));
  const bar = `[${GLYPHS.full.repeat(filled)}${GLYPHS.empty.repeat(barCells - filled)}]`;
  return clip(bar + label, width);
}
