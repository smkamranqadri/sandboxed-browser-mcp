import test from "node:test";
import assert from "node:assert/strict";
import { REF, checkRef, gone, refGoneError } from "../../dist/refs.js";
import { ToolError } from "../../dist/tools.js";

test("a ref is e<n> or f<n>e<n>, as the view writes it, brackets and spaces aside", () => {
  for (const [raw, ref] of [["e12", "e12"], ["f2e7", "f2e7"], [" [e5] ", "e5"], ["[f10e300]", "f10e300"], ["ref=e3", "e3"]]) assert.equal(checkRef(raw), ref, raw);
  assert.ok(REF.test("f1e1") && !REF.test("e") && !REF.test("f2"));
});

test("something not shaped like a ref is told so, with an example", () => {
  for (const raw of ["#save", "save button", "e", "f2", "x12", "e12 ", "button e12"].filter((r) => r !== "e12 ")) {
    assert.throws(
      () => checkRef(raw),
      (e) => e instanceof ToolError && e.message === `"${raw}" cannot be used as a ref: refs are short codes such as e12 or f2e7, copied from the brackets that end a line of browser_snapshot or browser_find.`,
      raw,
    );
  }
});

test("a ref that points nowhere has one answer, and the browser's errors for it are known", () => {
  assert.equal(gone("f2e9").message, "f2e9 points at nothing on the page now: its element was removed or replaced, the page changed, or it never existed. Get a fresh ref from browser_snapshot or browser_find.");
  assert.ok(gone("e1") instanceof ToolError);
  assert.equal(refGoneError(new Error('locator.count: Invalid frame in aria-ref selector "aria-ref=f1e5"')), true);
  // A call log that only names the selector is not that error (typing into a button names it too).
  assert.equal(refGoneError(new Error("locator.fill: Error: Element is not an <input>\nCall log:\n  - waiting for locator('aria-ref=f1e12')")), false);
});
