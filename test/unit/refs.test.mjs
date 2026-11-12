import test from "node:test";
import assert from "node:assert/strict";
import { REF, checkRef, gone, refGoneError, tagRefs } from "../../dist/refs.js";
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

test("with several profiles a ref carries its profile's tag, and a call accepts only the tag of its own profile", () => {
  const work = { profile: "work", tagged: true };
  const main = { profile: "default", tagged: true };
  const alone = { profile: "default", tagged: false };
  assert.equal(checkRef("e12@work", work), "e12");
  assert.equal(checkRef("[f2e7@work]", work), "f2e7");
  assert.equal(checkRef("ref=e3@work", work), "e3");
  assert.equal(checkRef("e12", main), "e12", "the default profile's refs have no tag");
  assert.equal(checkRef("e12@default", main), "e12");
  assert.equal(checkRef("e12", alone), "e12");
  assert.equal(checkRef("e12"), "e12");
  const refused = (raw, scope, message) => assert.throws(() => checkRef(raw, scope), (e) => e instanceof ToolError && e.message === message, raw);
  refused("e1@personal", work, "e1@personal is a ref of profile personal, and this call is for profile work: a ref works only in the profile it came from. Get a ref from this profile's own browser_snapshot or browser_find.");
  refused("e1@work", main, "e1@work is a ref of profile work, and this call is for profile default: a ref works only in the profile it came from. Get a ref from this profile's own browser_snapshot or browser_find.");
  refused("e1@default", work, "e1@default is a ref of the default profile, and this call is for profile work: a ref works only in the profile it came from. Get a ref from this profile's own browser_snapshot or browser_find.");
  refused("e1", work, "e1 has no profile tag, so it is a ref of the default profile, and this call is for profile work: a ref works only in the profile it came from. Refs of profile work end in @work (e1@work); get one from this profile's own browser_snapshot or browser_find.");
  refused("e1@work", alone, "e1@work is a ref of profile work, and this call is for profile default: a ref works only in the profile it came from. Get a ref from this profile's own browser_snapshot or browser_find.");
  assert.throws(() => checkRef("e1@work"), (e) => e instanceof ToolError && /^e1@work is a ref of profile work, and this call is for no other profile/.test(e.message));
  assert.throws(() => checkRef("x1@work", work), /cannot be used as a ref/);
});

test("tagRefs writes the profile after every ref in brackets of an answer, and nothing else", () => {
  assert.equal(tagRefs('button "Save" [e12] disabled\nlink "a"[f2e7] and word[e3]', "work"), 'button "Save" [e12@work] disabled\nlink "a"[f2e7@work] and word[e3@work]');
  assert.equal(tagRefs("e12 points at nothing [x1] [e]", "work"), "e12 points at nothing [x1] [e]");
});
