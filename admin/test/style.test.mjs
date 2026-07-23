import assert from "node:assert/strict";
import { test } from "node:test";
import { makeStyler, frame, RULE, PLAIN_THEME, stripAnsi, visibleLen } from "../src/style.mjs";

// A theme whose fg/bold emit REAL SGR (so the module's stripAnsi recovers the visible text) and RECORD
// every (color,text) request, so we can assert both the width invariant and the color choices.
function spyTheme() {
  const calls = [];
  return {
    calls,
    fg(color, text) {
      calls.push({ color, text });
      return `\x1b[38;5;42m${text}\x1b[39m`;
    },
    bold(text) {
      return `\x1b[1m${text}\x1b[22m`;
    },
    bg: (_c, t) => t,
  };
}

test("stripAnsi / visibleLen recover the visible column count through SGR", () => {
  const colored = "\x1b[38;5;42mhi\x1b[39m";
  assert.equal(stripAnsi(colored), "hi");
  assert.equal(visibleLen(colored), 2);
});

test("cell pads plain text to exactly `width` columns; color does NOT change the visible width", () => {
  const plainStyler = makeStyler(PLAIN_THEME);
  assert.equal(plainStyler.cell("hi", 6), "hi    "); // padEnd on plain text
  assert.equal(visibleLen(plainStyler.cell("hi", 6)), 6);

  const colorStyler = makeStyler(spyTheme());
  const c = colorStyler.cell("hi", 6, { color: "accent" });
  assert.equal(visibleLen(c), 6, "colored cell still measures 6 visible columns");
  assert.equal(stripAnsi(c), "hi    ", "plain content and padding are unchanged under color");
  assert.notEqual(c, "hi    ", "color was actually applied");
});

test("cell clips over-long text with an ellipsis, still exactly `width`", () => {
  const s = makeStyler(PLAIN_THEME);
  assert.equal(s.cell("abcdefgh", 5), "abcd…");
  assert.equal(visibleLen(s.cell("abcdefgh", 5)), 5);
});

test("cell right-aligns when asked", () => {
  const s = makeStyler(PLAIN_THEME);
  assert.equal(s.cell("7", 4, { align: "right" }), "   7");
});

test("meter is exactly `width` columns, colored by state, with the bar + label", () => {
  const s = makeStyler(spyTheme());
  for (const [reserved, cap, state] of [[6, 25, "ok"], [18, 20, "soft-hold"], [30, 25, "over"]]) {
    const m = s.meter(reserved, cap, 40, state);
    assert.equal(visibleLen(m), 40, `meter ${reserved}/${cap} must be 40 columns`);
    assert.match(stripAnsi(m), new RegExp(`${reserved}/${cap}`));
    assert.match(stripAnsi(m), /\[█*░*\]/);
  }
  // the state color drives the fill/label color: over -> error, soft-hold -> warning, ok -> success
  const spy = spyTheme();
  makeStyler(spy).meter(30, 25, 40, "over");
  assert.ok(spy.calls.some((c) => c.color === "error"), "over-budget meter uses the error color");
});

test("meter with an unknown cap renders the 'cap unknown' note at `width`", () => {
  const s = makeStyler(PLAIN_THEME);
  const m = s.meter(5, null, 40, "ok");
  assert.equal(visibleLen(m), 40);
  assert.match(stripAnsi(m), /5 \/ \? \(cap unknown\)/);
});

test("divider fills exactly `width` with a rule and optional right-side meta", () => {
  const s = makeStyler(PLAIN_THEME);
  const d = s.divider("spend", "jobs started", 50);
  assert.equal(visibleLen(d), 50);
  const plain = stripAnsi(d);
  assert.match(plain, /^SPEND ─+ jobs started$/);
});

test("frame: every line is exactly `width` visible columns, borders included", () => {
  const s = makeStyler(spyTheme());
  const inner = 40 - 4;
  const lines = [s.cell("STATUS", inner, { color: "muted", strong: true }), RULE, s.cell("Queue: running", inner)];
  const framed = frame(s, { title: "pi-dispatch", width: 40, lines, footer: s.cell("[q]uit", inner) });
  for (const line of framed) {
    assert.equal(visibleLen(line), 40, `framed line must be 40 columns: ${JSON.stringify(stripAnsi(line))}`);
  }
  // top/bottom corners + a separator rule present (after stripping color)
  assert.match(stripAnsi(framed[0]), /^┌─ pi-dispatch ─+┐$/);
  assert.match(stripAnsi(framed.at(-1)), /^└─+┘$/);
  assert.ok(framed.some((l) => /^├─+┤$/.test(stripAnsi(l))), "a separator rule is present");
});

test("frame degrades to plain glyphs under PLAIN_THEME but keeps the same geometry", () => {
  const s = makeStyler(PLAIN_THEME);
  const inner = 30 - 4;
  const framed = frame(s, { title: "x", width: 30, lines: [s.cell("hi", inner)] });
  for (const line of framed) assert.equal(line.length, 30); // no ANSI, so .length === visible width
});
