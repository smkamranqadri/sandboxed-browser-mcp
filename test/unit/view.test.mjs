import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { changes, excerpt, findRef, fullText, outline, render, search } from "../../dist/view.js";

/**
 * The view, find and get_text as pure functions, on aria trees the real browser gave for the fixture pages
 * (test/unit/fixtures/*.json, taken with page.ariaSnapshotJSON({ mode: "ai", boxes: true }) on the test stack).
 */

const fixture = (name) => JSON.parse(readFileSync(path.resolve(import.meta.dirname, "fixtures", `${name}.json`), "utf8"));
const parts = (text) => {
  const [head, body, foot] = text.split("\n\n");
  return { head: head.split("\n"), body: body.split("\n"), foot: foot ? foot.split("\n") : [] };
};

test("a short page: the header, one line per element with its ref, and no footer", () => {
  const { head, body, foot } = parts(render(fixture("form")).text);
  assert.deepEqual(head, ["Page: Seed order — http://allowed.fixture.test/form", "View: 0–644 of 644 px (100%), 1,024×644"]);
  // The labels' own text ("Name" before the Name field) and the paragraphs around the fields add nothing: dropped.
  assert.deepEqual(body, [
    'heading "Seed order" [f1e2] level=1',
    'textbox "Name" [f1e5]',
    'combobox "Plan" [f1e7]',
    '  option "Free" selected',
    '  option "Pro"',
    '  option "Team"',
    'textbox "Notes" [f1e9]',
    'textbox "Gift message" [f1e10]',
    'button "Send" [f1e12]',
    'link "Seed catalogue" [f1e14]',
  ]);
  assert.deepEqual(foot, []);
});

test("index mode: only what can be clicked, typed into or chosen, without nesting", () => {
  const { head, body } = parts(render({ ...fixture("form"), mode: "index" }).text);
  assert.equal(head[1], "View: 0–644 of 644 px (100%), 1,024×644; only the controls (what can be clicked, typed into or chosen) are listed");
  assert.deepEqual(body, ['textbox "Name" [f1e5]', 'combobox "Plan" [f1e7]', 'textbox "Notes" [f1e9]', 'textbox "Gift message" [f1e10]', 'button "Send" [f1e12]', 'link "Seed catalogue" [f1e14]']);
});

test("a long page: thousands separators, how far down the view ends, and every line either shown or counted", () => {
  const input = fixture("long");
  const { text, lines } = render(input);
  const { head, foot } = parts(text);
  assert.equal(head[1], "View: 0–644 of 4,499 px (14%), 1,024×644");
  assert.equal(foot.length, 1);
  const below = Number(foot[0].match(/^Below the view: (\d+) more lines \(scroll down, or use browser_find\)\.$/)[1]);
  assert.ok(below > 0);
  assert.equal(lines.length + below, outline(input.tree).length);

  const scrolled = fixture("long-scrolled");
  const view = parts(render(scrolled).text);
  assert.equal(view.head[1], "View: 1,800–2,444 of 4,499 px (54%), 1,024×644");
  assert.equal(view.foot.length, 2);
  const up = Number(view.foot[0].match(/^Above the view: (\d+) more lines\.$/)[1]);
  const down = Number(view.foot[1].match(/^Below the view: (\d+) more lines \(scroll down, or use browser_find\)\.$/)[1]);
  assert.ok(up > 0 && down > 0);
  assert.equal(render(scrolled).lines.length + up + down, outline(scrolled.tree).length);
});

test("a line longer than the limit is cut at a word, saying how much is left and how to read it", () => {
  const input = fixture("long");
  const line = render(input).lines.find((l) => l.text.startsWith("paragraph: The valley's oldest"));
  const m = line.text.match(/^paragraph: (.+)… \(\+(\d+) chars: get_text (f\d+e\d+)\) \[\3\]$/);
  assert.ok(m, line.text);
  const full = findRef(input.tree, m[3]).text;
  assert.ok(full.startsWith(m[1]));
  assert.equal(Number(m[2]), full.length - m[1].length);
  assert.ok(m[1].length <= 200);
});

test("a link inside running text is written in place, so the sentence reads as one", () => {
  const { body } = parts(render(fixture("plain")).text);
  assert.equal(body[1], "paragraph: Read the sowing chart[f6e4] before you plant, and keep it by the door. [f6e3]");
  assert.ok(!body.some((l) => l.startsWith('link "sowing chart"')), "not again as a line of its own");
});

test("a frame's content is part of the view, under its iframe line, with its own refs", () => {
  const { body } = parts(render(fixture("frames")).text);
  assert.deepEqual(body.slice(2), ["iframe [f4e4]", '  heading "Valley weather" [f5e2] level=2', "  paragraph: Light rain until noon, then sun. [f5e3]", '  button "Refresh the weather" [f5e4]']);
});

test("tables and lists keep their own lines; row groups that add nothing do not", () => {
  const { body } = parts(render(fixture("long-scrolled")).text);
  const at = body.indexOf("  table [f3e43]");
  assert.ok(at > 0, body.join("\n"));
  assert.deepEqual(body.slice(at, at + 4), ["  table [f3e43]", "    row [f3e45]", '      columnheader "Crop" [f3e46]', '      columnheader "Days to harvest" [f3e47]']);
  assert.ok(body.includes("    listitem: Beans: sow after the last frost. [f3e40]"));
  assert.ok(!body.some((l) => l.includes("rowgroup")));
});

test("the view has a size cap, and says how to see what is past it", () => {
  const tree = [{ role: "generic", children: Array.from({ length: 600 }, (_, i) => ({ role: "paragraph", ref: `e${i + 1}`, text: `Line ${i + 1} of a page that goes on and on.`, box: { x: 0, y: 0, width: 100, height: 10 } })) }];
  const { text, lines } = render({ title: "Many", url: "http://allowed.fixture.test/many", metrics: { width: 800, height: 600, scrollY: 0, scrollHeight: 600 }, tree });
  assert.ok(text.length < 13_000, String(text.length));
  assert.ok(lines.length < 600);
  assert.match(text, new RegExp(`\\n\\[The view stops here at its size limit, with ${600 - lines.length} more lines on screen: scroll a little, or use browser_find\\.\\]$`));
});

test("what changed: an element changed (~), appeared (+) or went (-); the focus moving alone is no change", () => {
  const before = ['heading "Seed order" [e2] level=1', 'textbox "Name" [e5]', 'button "Send" [e12]', "paragraph: Resting [e20]"];
  const after = ['heading "Seed order" [e2] level=1', 'textbox "Name": Rowan Vale [e5] active', 'button "Send" [e12] disabled', 'alert: Order received for Rowan Vale. [e16]'];
  assert.deepEqual(changes(before, after), [
    '~ textbox "Name" [e5]  →  textbox "Name": Rowan Vale [e5] active',
    '~ button "Send" [e12]  →  button "Send" [e12] disabled',
    "- paragraph: Resting [e20]",
    "+ alert: Order received for Rowan Vale. [e16]",
  ]);
  assert.deepEqual(changes(['button "Work hard" [e3]', "paragraph: Resting [e4]"], ['button "Work hard" [e3] active', "paragraph: Busy done [e4]"]), ["~ paragraph: Resting [e4]  →  paragraph: Busy done [e4]"]);
  // A renamed element gets a new ref: paired with the old line by its role.
  assert.deepEqual(changes(['button "Wait for it" [e2] disabled'], ['button "Clicked late" [e5] active']), ['~ button "Wait for it" [e2] disabled  →  button "Clicked late" [e5] active']);
  assert.deepEqual(changes(['option "Free" selected', 'option "Pro"'], ['option "Free"', 'option "Pro" selected']), ['~ option "Free" selected  →  option "Free"', '~ option "Pro"  →  option "Pro" selected']);
  assert.deepEqual(changes(["a [e1]"], ["a [e1] active"]), []);
});

test("find: every word, any case, anywhere on the page, nearest to the view first, with the distance", () => {
  const input = fixture("long");
  const { hits: lines, extra } = search(input.tree, input.metrics, "HARVEST");
  assert.equal(extra, 0);
  const below = (ref) => {
    const box = findRef(input.tree, ref).box;
    return (box.y - input.metrics.height).toLocaleString("en-US");
  };
  assert.deepEqual(lines, [
    'link "Harvest" [f2e5] (on screen)',
    `columnheader "Days to harvest" [f2e47] (${below("f2e47")} px down)`,
    `heading "Harvest calendar" [f2e73] level=2 (${below("f2e73")} px down)`,
  ]);
  assert.deepEqual(search(input.tree, input.metrics, "harvest calendar").hits, [`heading "Harvest calendar" [f2e73] level=2 (${below("f2e73")} px down)`]);
  assert.deepEqual(search(input.tree, input.metrics, "zebra crossing").hits, []);
  const many = search(input.tree, input.metrics, "keep the rows");
  assert.equal(many.hits.length, 15);
  assert.ok(many.extra > 0);

  const scrolled = fixture("long-scrolled");
  const above = search(scrolled.tree, scrolled.metrics, "watering").hits;
  assert.equal(above.length, 2);
  assert.match(above[0], /^link "Watering" \[f3e4\] \(on screen\)$/, "the sticky bar's link is in view");
  const box = findRef(scrolled.tree, "f3e10").box;
  assert.equal(above[1], `heading "Watering" [f3e10] level=2 (${(-(box.y + box.height)).toLocaleString("en-US")} px up)`);
});

test("get_text: the element's text as plain text, in pages that end at a word and join up to the whole", () => {
  const input = fixture("long");
  const article = findRef(input.tree, "f2e36");
  const text = fullText(article);
  const lines = text.split("\n");
  assert.equal(lines[0], "## Growing guide");
  assert.ok(lines.includes("- Beans: sow after the last frost."));
  assert.ok(lines.includes("Crop | Days to harvest"));
  assert.ok(lines.includes("Radish | 25"));
  assert.ok(lines.includes("### Saving seed"));

  const got = [];
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    const answer = excerpt(text, "f2e36", offset, 300);
    const m = answer.match(/^([\s\S]*)\n\n\[characters (\d+)–(\d+) of (\d+); (next: get_text f2e36 offset=(\d+)|end of text)\]$/);
    assert.ok(m, answer);
    const [, chunk, from, to, total, more, next] = m;
    assert.equal(Number(from), offset);
    assert.equal(Number(total), text.length);
    assert.equal(chunk.length, Number(to) - Number(from));
    assert.ok(chunk.length <= 300);
    got.push(chunk);
    if (more === "end of text") {
      assert.equal(Number(to), text.length);
      break;
    }
    assert.equal(Number(next), Number(to));
    assert.match(text[Number(to)], /\s/, "a page ends before a space, not inside a word");
    offset = Number(next);
  }
  assert.ok(got.length > 2);
  assert.equal(got.join(""), text);
});
