import test from "node:test";
import assert from "node:assert/strict";
import { ToolError, keyCombo } from "../../dist/tools.js";

test("keys as people write them become the browser's names, joined by +", () => {
  const cases = {
    "ctrl+a": "Control+a",
    "Ctrl+A": "Control+A",
    "cmd+shift+t": "Meta+Shift+t",
    "command+k": "Meta+k",
    "meta+Enter": "Meta+Enter",
    "control+alt+delete": "Control+Alt+Delete",
    "option+left": "Alt+ArrowLeft",
    "shift+tab": "Shift+Tab",
    esc: "Escape",
    ESCAPE: "Escape",
    enter: "Enter",
    return: "Enter",
    space: "Space",
    backspace: "Backspace",
    pageup: "PageUp",
    PageDown: "PageDown",
    up: "ArrowUp",
    down: "ArrowDown",
    home: "Home",
    end: "End",
    f5: "F5",
    a: "a",
    A: "A",
    "?": "?",
  };
  for (const [given, pressed] of Object.entries(cases)) assert.equal(keyCombo(given), pressed, given);
});

test("a + at the start or right after another + is the plus key itself", () => {
  assert.equal(keyCombo("ctrl++"), "Control++");
  assert.equal(keyCombo("+"), "+");
  assert.equal(keyCombo("shift++"), "Shift++");
});

test("an unknown key name, or none, is answered at once", () => {
  for (const bad of ["ctrl+banana", "hyper", ""]) {
    assert.throws(() => keyCombo(bad), (e) => e instanceof ToolError && /key/.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => keyCombo("ctrl+banana"), /^Error: "banana" is not a key the browser knows\./);
});
