import { ToolError } from "./errors.js";

/** The browser's key names, each with the ways people write it (any case). */
const SPELLINGS: Array<[string, string]> = [
  ["Meta", "meta cmd command win super"],
  ["Control", "control ctrl"],
  ["Alt", "alt option opt"],
  ["Shift", "shift"],
  ["Escape", "escape esc"],
  ["Enter", "enter return"],
  ["Tab", "tab"],
  ["Space", "space spacebar"],
  ["Backspace", "backspace"],
  ["Delete", "delete del"],
  ["Insert", "insert ins"],
  ["Home", "home"],
  ["End", "end"],
  ["PageUp", "pageup pgup"],
  ["PageDown", "pagedown pgdn"],
  ["ArrowUp", "arrowup up"],
  ["ArrowDown", "arrowdown down"],
  ["ArrowLeft", "arrowleft left"],
  ["ArrowRight", "arrowright right"],
  ["CapsLock", "capslock"],
  ["ContextMenu", "contextmenu menu"],
  ["+", "plus"],
  ["-", "minus"],
];

/** Lower-case spelling → the browser's name: the list above, and the browser's other names spelled as they are. */
const KEYS = new Map<string, string>();
for (const [key, spellings] of SPELLINGS) for (const s of spellings.split(" ")) KEYS.set(s, key);
for (const key of [
  "Backquote", "Minus", "Equal", "Backslash", "BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "Slash",
  "NumLock", "ScrollLock", "Pause", "PrintScreen", "ControlOrMeta",
]) {
  KEYS.set(key.toLowerCase(), key);
}
for (let i = 1; i <= 24; i++) KEYS.set(`f${i}`, `F${i}`);
for (let i = 0; i <= 9; i++) KEYS.set(`digit${i}`, `Digit${i}`), KEYS.set(`numpad${i}`, `Numpad${i}`);
for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") KEYS.set(`key${letter.toLowerCase()}`, `Key${letter}`);

/** The parts of a combination: split on `+`, where a `+` with nothing before it (in its part) is the plus key. */
function split(text: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const next = text.indexOf("+", i + 1);
    const end = next === -1 ? text.length : next;
    parts.push(text.slice(i, end));
    i = end + 1;
  }
  return parts;
}

/**
 * A key or combination as people write it (`ctrl+a`, `cmd+shift+t`, `esc`, `ctrl++`), in the browser's names joined by
 * `+` (`Control+a`, `Meta+Shift+t`, `Escape`, `Control++`). One character stays as it is, case included. A name the
 * browser does not know is a ToolError.
 */
export function keyCombo(text: string): string {
  const source = text.trim() || text;
  if (!source) throw new ToolError("No key was given: name one, such as Enter, Escape or ctrl+a.");
  return split(source)
    .map((part) => {
      const name = part.trim() || part;
      if ([...name].length === 1) return name;
      const key = KEYS.get(name.toLowerCase());
      if (key) return key;
      throw new ToolError(`"${name}" is not a key the browser knows. Use names such as Enter, Escape, Tab, Backspace, ArrowDown, PageDown or F5, or a single character, joined by + as in ctrl+a.`);
    })
    .join("+");
}
