import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GLYPHS, clip, pad, box, meter } from "../src/panel.mjs";

test("panel.mjs is pure: no fs, no require, no node:fs import", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/panel.mjs", import.meta.url)), "utf8");
  assert.ok(
    !/readFileSync|\breadFile\b|require\(|import\s+.*node:fs/.test(src),
    "panel primitives must have no I/O -- they take values in and return strings",
  );
});

test("box frames a title, sections, and footer within width", () => {
  const width = 30;
  const out = box({
    title: "STATUS",
    sections: [
      { title: "Queue", lines: ["waiting 2", "active 1"] },
      { lines: ["workers: 1"] },
    ],
    footer: "updated 00:00",
    width,
  });
  assert.ok(Array.isArray(out));
  const joined = out.join("\n");
  assert.match(joined, new RegExp(GLYPHS.tl));
  assert.match(joined, new RegExp(GLYPHS.br));
  assert.match(joined, new RegExp(GLYPHS.ml), "a section separator rule is present");
  assert.match(joined, /STATUS/);
  assert.match(joined, /Queue/);
  assert.match(joined, /waiting 2/);
  assert.match(joined, /workers: 1/);
  assert.match(joined, /updated 00:00/);
  for (const line of out) {
    assert.ok(line.length <= width, `line "${line}" (${line.length}) exceeds width ${width}`);
  }
});

test("box degrades on a tiny width without emitting over-width lines", () => {
  const out = box({ title: "way-too-long-title", sections: [{ lines: ["content"] }], footer: "f", width: 3 });
  assert.ok(out.length >= 2, "still produces a top and bottom border");
  const maxLen = Math.max(...out.map((l) => l.length));
  for (const line of out) {
    assert.equal(line.length, maxLen, "degraded frame stays rectangular, never ragged or over-width");
  }
});

test("meter renders a bar glyph and reserved/cap", () => {
  const out = meter(3, 10, 24);
  assert.match(out, new RegExp(GLYPHS.full), "a filled block glyph appears");
  assert.match(out, /3\/10/);
});

test("meter renders (cap unknown) with no bar glyph when cap is not a positive integer", () => {
  const out = meter(5, null, 24);
  assert.match(out, /\(cap unknown\)/);
  assert.doesNotMatch(out, new RegExp(GLYPHS.full), "no bar when the cap is unknown");
  assert.doesNotMatch(out, new RegExp(GLYPHS.empty), "no bar when the cap is unknown");
  assert.doesNotMatch(meter(5, 0, 24), /\[/, "cap of 0 is not a positive integer");
});

test("clip truncates long input to width and ends with the ellipsis glyph", () => {
  const out = clip("abcdefghij", 5);
  assert.equal(out.length, 5);
  assert.ok(out.endsWith(GLYPHS.ellipsis));
});

test("clip leaves short input unchanged", () => {
  assert.equal(clip("abc", 10), "abc");
});

test("clip survives control characters and stays within width", () => {
  const evil = `a\x1b[31mb\x00c\x07d\x7f`;
  const out = clip(evil, 6);
  assert.ok(out.length <= 6, "width is respected after control chars are stripped");
  assert.doesNotMatch(out, /[\x00-\x1f\x7f-\x9f]/, "control characters are removed"); // eslint-disable-line no-control-regex
});

test("pad right-pads short input to exactly width", () => {
  const out = pad("hi", 6);
  assert.equal(out.length, 6);
  assert.equal(out, "hi    ");
});

test("pad clips long input to width", () => {
  const out = pad("abcdefghij", 4);
  assert.equal(out.length, 4);
  assert.ok(out.endsWith(GLYPHS.ellipsis));
});
