/**
 * Overlay-only color + layout helpers for the /dispatch dashboard, built on pi's injected `Theme`.
 *
 * The invariant that keeps color safe (feasibility-verified against pi-tui):
 *   - COLOR IS APPLIED POST-LAYOUT. Every width/padding decision is made on PLAIN text; color is the last
 *     transform. pi's overlay host measures each returned line with the ANSI-aware `visibleWidth` and
 *     appends its own SGR reset, so post-layout color adds 0 to the measured width and cannot disturb
 *     framing or the `width:"75%"` overlay clamp.
 *   - This module is OVERLAY-ONLY. `render.mjs`/`panel.mjs` deliberately stay plain because they also feed
 *     `pi.sendMessage` (the model-visible channel) and the untrusted `.log` tail's `clip` escape-strip.
 *     Nothing here is imported by those paths.
 *
 * `theme` is the instance pi hands the `ctx.ui.custom` factory. It is injected (pi-tui is not importable
 * from here — nested, non-hoisted), so every helper takes a styler bound to that instance. `makeStyler`
 * accepts a null theme (tests / no-TUI) and degrades to plain text with the SAME plain layout, so a test
 * can assert both the plain content and the width math without a real terminal.
 */

// Strip SGR (and OSC-8 hyperlink) escapes to recover the visible text / column count. Content is
// ASCII + box-drawing + a handful of width-1 glyphs, so post-strip `.length` is a safe column proxy.
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

export function stripAnsi(s) {
  return String(s ?? "").replace(ANSI, "");
}

/** Visible column count of a (possibly colored) string. */
export function visibleLen(s) {
  return stripAnsi(s).length;
}

/** A no-op theme: `fg`/`bg`/`bold`/… return the text unchanged. Used in tests and when no TUI theme exists. */
export const PLAIN_THEME = {
  fg: (_c, t) => t,
  bg: (_c, t) => t,
  bold: (t) => t,
  italic: (t) => t,
  underline: (t) => t,
  inverse: (t) => t,
  strikethrough: (t) => t,
};

/**
 * Bind the color helpers to a `theme` instance (or PLAIN_THEME). Every helper computes layout on plain
 * text and applies color last, so the returned strings have a KNOWN visible width equal to their plain
 * width.
 */
export function makeStyler(theme) {
  const th = theme ?? PLAIN_THEME;

  /** Color `text` with a theme color, or return it unchanged when `color` is falsy. */
  const fg = (color, text) => (color ? th.fg(color, String(text)) : String(text));
  const bold = (text) => th.bold(String(text));

  /**
   * A fixed-width cell: PLAIN text is clipped+padded to exactly `width` visible columns, THEN colored.
   * `align` is "left" | "right". `bold` bolds after coloring. Result's visible width === `width`.
   */
  const cell = (text, width, { color = null, align = "left", strong = false } = {}) => {
    const w = Math.max(0, Math.trunc(width) || 0);
    let plain = String(text ?? "");
    if (plain.length > w) plain = w <= 1 ? plain.slice(0, w) : plain.slice(0, w - 1) + "…";
    plain = align === "right" ? plain.padStart(w) : plain.padEnd(w);
    let out = color ? fg(color, plain) : plain;
    return strong ? bold(out) : out;
  };

  /** A small colored token (no padding). Visible width === label.length (+ padding if `pad`). */
  const badge = (label, color, { pad = false } = {}) => {
    const text = pad ? ` ${label} ` : String(label);
    return fg(color, text);
  };

  /**
   * A block-char spend meter fitted to `width` visible columns: `[███░░░] r/cap`. The filled cells take
   * `state`'s color (ok→success, soft-hold→warning, over→error), the empty cells `dim`, the label the
   * state color too. When `cap` is not a positive integer the true cap is unknown, so it renders
   * `r / ? (cap unknown)` with no bar. Visible width === `width`.
   */
  const meter = (reserved, cap, width, state = "ok") => {
    const w = Math.max(8, Math.trunc(width) || 8);
    const r = Number.isFinite(reserved) ? Math.max(0, Math.trunc(reserved)) : 0;
    const stateColor = state === "over" ? "error" : state === "soft-hold" ? "warning" : "success";
    if (!Number.isInteger(cap) || cap <= 0) {
      const plain = `${r} / ? (cap unknown)`;
      return cell(plain, w, { color: "dim" });
    }
    const label = ` ${r}/${cap}`;
    const barCells = Math.max(0, w - label.length - 2); // "[" + cells + "]"
    const filled = Math.min(barCells, Math.round((Math.min(r, cap) / cap) * barCells));
    // Build colored, keep track of visible width == w exactly.
    const open = fg("dim", "[");
    const fillPart = filled > 0 ? fg(stateColor, "█".repeat(filled)) : "";
    const emptyPart = barCells - filled > 0 ? fg("dim", "░".repeat(barCells - filled)) : "";
    const close = fg("dim", "]");
    const labelPart = fg(stateColor, label);
    return open + fillPart + emptyPart + close + labelPart;
  };

  /**
   * A section divider that fills `width`: `LABEL ─────────── meta`. `label` is bold/muted, the rule is
   * `border`-colored, `meta` (optional, right side) is `dim`. Visible width === `width`.
   */
  const divider = (label, meta, width) => {
    const w = Math.max(4, Math.trunc(width) || 4);
    const lab = String(label ?? "").toUpperCase();
    const met = String(meta ?? "");
    const ruleLen = Math.max(1, w - lab.length - met.length - (met ? 2 : 1));
    const labPart = lab ? bold(fg("muted", lab)) + " " : "";
    const rulePart = fg("border", "─".repeat(ruleLen));
    const metPart = met ? " " + fg("dim", met) : "";
    return labPart + rulePart + metPart;
  };

  /**
   * Join pre-built cells (each already exactly its width) with a plain separator. The separator is plain
   * (its width counts); cells carry their own color. Visible width === sum(cellWidths) + sep widths.
   */
  const joinCells = (cells, sep = "  ") => cells.join(sep);

  return { theme: th, fg, bold, cell, badge, meter, divider, joinCells, stripAnsi, visibleLen };
}

/**
 * Frame `lines` (each already EXACTLY `inner = width-4` visible columns) into a titled box with colored
 * borders. `title` is bold; `footer` (optional) is set off by a rule. Returns `string[]`; each line's
 * visible width === `width`. The border glyphs are `border`-colored; the caller owns the inner content's
 * color. Mirrors panel.mjs `box`'s geometry so widths line up, but colored and overlay-only.
 */
export function frame(styler, { title = "", width = 40, lines = [], footer = null } = {}) {
  const w = Math.max(8, Math.trunc(width) || 8);
  const inner = w - 4;
  const B = (s) => styler.fg("border", s);
  const out = [];

  const titleText = title ? ` ${clipPlain(title, Math.max(0, inner - 2))} ` : "";
  const topFill = Math.max(0, w - 2 - 1 - titleText.length);
  out.push(B("┌─") + styler.bold(styler.fg("accent", titleText)) + B("─".repeat(topFill) + "┐"));

  const side = (content) => B("│") + " " + content + " " + B("│");
  const rule = () => B("├" + "─".repeat(w - 2) + "┤");

  for (const line of lines) {
    if (line === RULE) out.push(rule());
    else out.push(side(padVisible(styler, line, inner)));
  }

  if (footer !== null && footer !== undefined) {
    out.push(rule());
    out.push(side(padVisible(styler, footer, inner)));
  }

  out.push(B("└" + "─".repeat(w - 2) + "┘"));
  return out;
}

/** Sentinel a caller can push into `frame`'s `lines` to emit a `├──┤` separator rule. */
export const RULE = Symbol("rule");

/** Right-pad a possibly-colored line with plain spaces to `width` visible columns (never truncates up-front). */
function padVisible(styler, line, width) {
  const vis = styler.visibleLen(line);
  if (vis >= width) return line;
  return line + " ".repeat(width - vis);
}

/** Plain clip to `width` columns with an ellipsis (used for the title only; content is pre-sized). */
function clipPlain(s, width) {
  const plain = String(s ?? "");
  if (plain.length <= width) return plain;
  return width <= 1 ? plain.slice(0, width) : plain.slice(0, width - 1) + "…";
}
