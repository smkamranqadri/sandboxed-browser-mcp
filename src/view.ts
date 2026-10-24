/**
 * The page as the model reads it. Input: the browser's accessibility tree (Playwright's aria snapshot in its "ai" mode,
 * as JSON, with element boxes) and the window's measures. Output: text.
 *
 * The tree becomes an outline, a flat list of entries in document order with a depth each; the view prints the entries
 * near the viewport, one line each (`role "name": text [ref] states`). The same outline answers what changed between two
 * looks, a search of the whole page, and an element's full text. Nothing here talks to a browser.
 */

/** One node of the snapshot JSON. Text fragments come as plain strings among `children`. */
export type AriaNode = {
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  children?: Array<AriaNode | string>;
  box?: Rect;
  level?: number;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  active?: boolean;
  cursor?: string;
  url?: string;
  placeholder?: string;
};

/** A box in viewport pixels. */
export type Rect = { x: number; y: number; width: number; height: number };

/** The window: its inner size, how far the page is scrolled, and the page's full height. */
export type Metrics = { width: number; height: number; scrollY: number; scrollHeight: number };

/** One element as the outline holds it. `parent` is an index into the same outline, or -1. */
export type Entry = {
  role: string;
  name: string;
  text: string;
  ref?: string;
  states: string[];
  rect?: Rect;
  control: boolean;
  depth: number;
  parent: number;
};

/** A line the model was shown, kept to say later what changed. `top`: the element's top on screen then. */
export type Line = { text: string; ref?: string; top?: number };

// ---- Roles -------------------------------------------------------------------------------------------------------

/**
 * What each role is, for the view. A role may have several kinds:
 * - control: something to click, type into or choose from (listed in index mode);
 * - wrapper: only groups; it leaves the outline when it has no name and no words of its own;
 * - holder: says what its content is, so it stays even around a single child;
 * - phrase: its words run on inside a sentence.
 * Roles not listed are plain: kept when they have a name, words, or more than one child.
 */
const ROLES: Record<string, string> = {
  button: "control",
  link: "control phrase",
  textbox: "control",
  searchbox: "control",
  combobox: "control",
  listbox: "control holder",
  option: "control",
  checkbox: "control",
  radio: "control",
  switch: "control",
  slider: "control",
  spinbutton: "control",
  menuitem: "control",
  menuitemcheckbox: "control",
  menuitemradio: "control",
  tab: "control",
  treeitem: "control",
  gridcell: "control",
  generic: "wrapper phrase",
  none: "wrapper",
  presentation: "wrapper",
  group: "wrapper",
  paragraph: "wrapper",
  listitem: "wrapper",
  section: "wrapper",
  blockquote: "wrapper",
  figure: "wrapper",
  rowgroup: "wrapper",
  table: "holder",
  grid: "holder",
  treegrid: "holder",
  list: "holder",
  tree: "holder",
  menu: "holder",
  menubar: "holder",
  tablist: "holder",
  dialog: "holder",
  alertdialog: "holder",
  form: "holder",
  iframe: "holder",
  strong: "phrase",
  emphasis: "phrase",
  code: "phrase",
  mark: "phrase",
  time: "phrase",
  subscript: "phrase",
  superscript: "phrase",
  insertion: "phrase",
  deletion: "phrase",
  abbr: "phrase",
  text: "phrase",
};

const is = (role: string, kind: "control" | "wrapper" | "holder" | "phrase"): boolean => (ROLES[role] ?? "").split(" ").includes(kind);

// ---- Small text helpers --------------------------------------------------------------------------------------------

/** A count with thousands separators: 4972 → "4,972". */
export const count = (n: number): string => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);

/** Text with its runs of white space made single spaces. */
const squash = (s: string): string => s.split(/\s+/).filter(Boolean).join(" ");

/** For comparing names and text: squashed, lower case. */
const same = (a: string | undefined, b: string | undefined): boolean => squash(a ?? "").toLowerCase() === squash(b ?? "").toLowerCase();

/** Marks that hug the word before them, and marks that hug the word after them. */
const HUG_LEFT = new Set([..."%,.;:!?)]}"]);
const HUG_RIGHT = new Set([..."([{"]);

/** Whether two pieces of running text are written with a space between them. */
const spaced = (left: string, right: string): boolean => left.length > 0 && !HUG_LEFT.has(right[0]) && !HUG_RIGHT.has(left.at(-1)!);

/** Pieces of running text joined back into one line of prose. */
function sentence(pieces: string[]): string {
  return pieces
    .map(squash)
    .filter((piece) => piece.length > 0)
    .reduce((line, piece) => line + (spaced(line, piece) ? " " : "") + piece, "");
}

/** The words of a node as they read in running text; a link's ref follows its words when `withRefs`. */
function wordsOf(node: AriaNode | string, withRefs: boolean): string {
  if (typeof node === "string") return squash(node);
  const own = node.text !== undefined ? squash(node.text) : sentence((node.children ?? []).map((c) => wordsOf(c, withRefs))) || squash(node.name ?? "");
  return withRefs && node.role === "link" && node.ref ? `${own}[${node.ref}]` : own;
}

/** The states of a node, in the order the view writes them. */
const STATES: Array<(n: AriaNode) => string | false | undefined> = [
  (n) => !!n.level && `level=${n.level}`,
  (n) => n.disabled && "disabled",
  (n) => n.selected && "selected",
  (n) => (n.checked === "mixed" ? "checked=mixed" : n.checked && "checked"),
  (n) => n.expanded && "expanded",
  (n) => (n.pressed === "mixed" ? "pressed=mixed" : n.pressed && "pressed"),
  (n) => n.active && "active",
];

const hasSize = (r?: Rect): r is Rect => !!r && (r.width > 0 || r.height > 0);

// ---- The outline ---------------------------------------------------------------------------------------------------

/**
 * The tree as an outline. With `inline`, links and other phrases inside running text are written into that text
 * (`word[ref]`), as the view shows them; without it each stands on its own, as search and index mode want them.
 */
export function outline(nodes: Array<AriaNode | string>, inline = true): Entry[] {
  const entries: Entry[] = [];
  for (const node of nodes) {
    if (typeof node === "string") {
      if (squash(node)) entries.push({ role: "text", name: "", text: squash(node), states: [], control: false, depth: 0, parent: -1 });
    } else entries.push(...shape(node, { inline, dx: 0, dy: 0, rect: undefined, words: "" }));
  }
  // Parents from the depths: each entry hangs under the nearest earlier entry one level up.
  const open: number[] = [];
  entries.forEach((entry, i) => {
    open.length = entry.depth;
    entry.parent = open.length ? open[open.length - 1] : -1;
    open.push(i);
  });
  return entries;
}

type Context = { inline: boolean; dx: number; dy: number; rect?: Rect; words: string };

/** A node and what it holds as entries, depths counted from this node (0); empty or its children when it is left out. */
function shape(node: AriaNode, at: Context): Entry[] {
  const rect = hasSize(node.box) ? { ...node.box, x: node.box.x + at.dx, y: node.box.y + at.dy } : at.rect;
  const children = node.children ?? [];
  const elements = children.filter((c): c is AriaNode => typeof c !== "string");
  const labels = elements.map((e) => e.name).filter((n): n is string => !!n);
  const isLabel = (s: string) => labels.some((n) => same(n, s));
  const loose = children.filter((c): c is string => typeof c === "string" && !!squash(c) && !isLabel(c));

  const pieces: string[] = node.text !== undefined ? [node.text] : [];
  const nested: AriaNode[] = [];
  for (const child of children) {
    if (typeof child === "string") {
      if (!isLabel(child)) pieces.push(child);
    } else if (at.inline && loose.length > 0 && is(child.role, "phrase") && !(child.role === "generic" && child.cursor === "pointer")) {
      pieces.push(wordsOf(child, true));
    } else nested.push(child);
  }

  const name = squash(node.name ?? "");
  let text = sentence(pieces);
  if (same(text, name)) text = "";
  const control = is(node.role, "control") || node.cursor === "pointer";
  const states = STATES.map((f) => f(node)).filter((s): s is string => typeof s === "string");

  // A frame's tree is measured inside the frame.
  const inner: Context = { inline: at.inline, dx: node.role === "iframe" && rect ? rect.x : at.dx, dy: node.role === "iframe" && rect ? rect.y : at.dy, rect, words: text };
  const below: Entry[] = [];
  for (const child of nested) below.push(...shape(child, inner));

  const says = !!name || !!text || control || states.some((s) => s !== "active");
  const roots = below.filter((e) => e.depth === 0).length;
  // Saying nothing, a wrapper always gives way to what it holds; anything else does when it holds one thing at most.
  if (!says && (is(node.role, "wrapper") || (roots <= 1 && !is(node.role, "holder")))) return below;
  // Nor is a line kept that only repeats the words of the line above it.
  if (!name && !control && text && same(text, at.words)) return below;

  const self: Entry = { role: node.role, name, text, ref: node.ref, states, rect, control, depth: 0, parent: -1 };
  return [self, ...below.map((e) => ({ ...e, depth: e.depth + 1 }))];
}

/** How much of a line's text is shown; the rest is pointed at. */
export const TEXT_LIMIT = 200;
const NAME_LIMIT = 150;
/** How much text a view's element lines may hold in all. */
export const VIEW_LIMIT = 12_000;

/** Long text cut near `TEXT_LIMIT` at a space, ending with how many characters are left and how to read them. */
export function clip(text: string, ref?: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  let end = TEXT_LIMIT;
  while (end > TEXT_LIMIT * 0.6 && text[end] !== " ") end--;
  if (text[end] !== " ") end = TEXT_LIMIT;
  const kept = text.slice(0, end).trimEnd();
  return `${kept}… (+${count(text.length - end)} chars${ref ? `: get_text ${ref}` : ""})`;
}

/** An entry as a line, without indent: `role "name": text [ref] states`. */
export function describe(entry: Entry): string {
  const name = entry.name.length > NAME_LIMIT ? `${entry.name.slice(0, NAME_LIMIT)}…` : entry.name;
  const parts = [entry.role + (name ? ` "${name}"` : "") + (entry.text ? `: ${clip(entry.text, entry.ref)}` : "")];
  if (entry.ref) parts.push(`[${entry.ref}]`);
  return [...parts, ...entry.states].join(" ");
}

// ---- The view ------------------------------------------------------------------------------------------------------

export type Shot = {
  title: string;
  url: string;
  metrics: Metrics;
  tree: Array<AriaNode | string>;
  /** "index": controls only, flat. */
  mode?: "a11y" | "index";
};

export type View = {
  text: string;
  /** The element lines shown, in order (without indent). */
  lines: Line[];
  /** The whole outline, every element of the page. */
  entries: Entry[];
};

/** The two header lines: `Page: <title> — <url>` and `View: <top>–<bottom> of <height> px (<percent>%), <w>×<h>`. */
export function heading(shot: Shot): string {
  const { width, height, scrollY, scrollHeight } = shot.metrics;
  const top = Math.max(0, Math.round(scrollY));
  const bottom = top + Math.round(height);
  const total = Math.max(bottom, Math.round(scrollHeight));
  const percent = total ? Math.min(100, Math.round((100 * bottom) / total)) : 100;
  const note = shot.mode === "index" ? "; only the controls (what can be clicked, typed into or chosen) are listed" : "";
  return `Page: ${shot.title.trim() || "(untitled)"} — ${shot.url}\nView: ${count(top)}–${count(bottom)} of ${count(total)} px (${percent}%), ${count(width)}×${count(height)}${note}`;
}

/** Where a box lies against the viewport widened by half a screen each way. */
function side(rect: Rect | undefined, metrics: Metrics): "above" | "inside" | "below" {
  const reach = metrics.height / 2;
  if (rect && rect.y + rect.height <= -reach) return "above";
  if (rect && rect.y >= metrics.height + reach) return "below";
  return "inside";
}

/**
 * The view: the header, the lines of what is in and around the viewport, and how many lines are above and below.
 * `skip`: refs of elements (with what they hold) not to print again; `note` is printed in their place.
 */
export function render(shot: Shot, skip: ReadonlySet<string> = new Set(), note = ""): View {
  const flat = shot.mode === "index";
  const entries = outline(shot.tree, !flat);
  const where = entries.map((e) => side(e.rect, shot.metrics));
  const shown = new Set<number>();
  if (flat) {
    entries.forEach((e, i) => e.control && e.ref && where[i] === "inside" && shown.add(i));
  } else {
    // In and around the viewport, with the lines that hold them, so the indent reads.
    entries.forEach((_, i) => {
      if (where[i] !== "inside") return;
      for (let at = i; at >= 0 && !shown.has(at); at = entries[at].parent) shown.add(at);
    });
  }
  const counted = entries.map((e, i) => i).filter((i) => !shown.has(i) && (!flat || (entries[i].control && entries[i].ref)));
  const above = counted.filter((i) => where[i] === "above").length;
  const below = counted.length - above;

  const skipped = (i: number): boolean => {
    for (let at = i; at >= 0; at = entries[at].parent) if (entries[at].ref && skip.has(entries[at].ref!)) return true;
    return false;
  };
  const order = [...shown].sort((a, b) => a - b).filter((i) => !skipped(i));

  const body: string[] = note ? [note] : [];
  const lines: Line[] = [];
  let used = 0;
  for (const [k, i] of order.entries()) {
    const entry = entries[i];
    const line = describe(entry);
    const printed = (flat ? "" : "  ".repeat(entry.depth)) + line;
    if (used + printed.length > VIEW_LIMIT) {
      body.push(`[The view stops here at its size limit, with ${count(order.length - k)} more lines on screen: scroll a little, or use browser_find.]`);
      break;
    }
    used += printed.length + 1;
    body.push(printed);
    lines.push({ text: line, ref: entry.ref, top: entry.rect?.y });
  }
  if (!body.length) body.push("(The part of the page in view has no text or controls.)");

  const foot: string[] = [];
  if (above) foot.push(`Above the view: ${count(above)} more lines.`);
  if (below) foot.push(`Below the view: ${count(below)} more lines (scroll down, or use browser_find).`);
  const text = [heading(shot), body.join("\n"), ...(foot.length ? [foot.join("\n")] : [])].join("\n\n");
  return { text, lines, entries };
}

// ---- What changed --------------------------------------------------------------------------------------------------

const refOf = (line: string): string | undefined => / \[((?:f\d+)?e\d+)\]/.exec(line)?.[1];
const roleOf = (line: string): string => /^[^ :]+/.exec(line)?.[0] ?? "";
/** The focus moving onto what was acted on is not a change worth telling. */
const withoutFocus = (line: string): string => line.replace(/ active$| active(?= )/, "");

/**
 * What changed from one look to the next, as lines marked `~` (an element changed: `old  →  new`), `+` (appeared) and
 * `-` (went). The two lists are aligned on their longest common run of equal lines; in each stretch between equal
 * lines, a gone line and a new one count as one element changed when they share a ref, or failing that a role.
 * Null when the lists are too long to align.
 */
export function changes(before: string[], after: string[]): string[] | null {
  const a = before.map(withoutFocus);
  const b = after.map(withoutFocus);
  const w = b.length + 1;
  if ((a.length + 1) * w > 1_000_000) return null;
  // best[i * w + j]: the longest common subsequence of the first i lines of a and the first j of b.
  const best = new Uint16Array((a.length + 1) * w);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      best[i * w + j] = a[i - 1] === b[j - 1] ? best[(i - 1) * w + j - 1] + 1 : Math.max(best[(i - 1) * w + j], best[i * w + j - 1]);
    }
  }
  // Walked back from the end: a list of steps, each keeping a line, dropping one of `before`, or adding one of `after`.
  const steps: Array<["keep" | "drop" | "add", number]> = [];
  for (let i = a.length, j = b.length; i > 0 || j > 0; ) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) steps.push(["keep", --i]), j--;
    else if (j > 0 && (i === 0 || best[i * w + j - 1] >= best[(i - 1) * w + j])) steps.push(["add", --j]);
    else steps.push(["drop", --i]);
  }
  steps.reverse();

  const out: string[] = [];
  let gone: number[] = [];
  let come: number[] = [];
  const settle = () => {
    const partner = new Map<number, number>();
    const taken = new Set<number>();
    const pair = (fits: (g: number, c: number) => boolean) => {
      for (const c of come) {
        if ([...partner.values()].includes(c)) continue;
        const g = gone.find((g) => !taken.has(g) && fits(g, c));
        if (g !== undefined) partner.set(g, c), taken.add(g);
      }
    };
    pair((g, c) => refOf(before[g]) !== undefined && refOf(before[g]) === refOf(after[c]));
    pair((g, c) => roleOf(before[g]) === roleOf(after[c]));
    const fresh = come.filter((c) => ![...partner.values()].includes(c));
    for (const g of gone) {
      const c = partner.get(g);
      if (c === undefined) {
        out.push(`- ${before[g]}`);
        continue;
      }
      while (fresh.length && fresh[0] < c) out.push(`+ ${after[fresh.shift()!]}`);
      out.push(`~ ${before[g]}  →  ${after[c]}`);
    }
    for (const c of fresh) out.push(`+ ${after[c]}`);
    gone = [];
    come = [];
  };
  for (const [kind, index] of steps) {
    if (kind === "keep") settle();
    else (kind === "drop" ? gone : come).push(index);
  }
  settle();
  return out;
}

// ---- Search --------------------------------------------------------------------------------------------------------

export const SEARCH_LIMIT = 15;

/** How far a box is from the screen, in px (0 when any of it shows), and the words saying so. */
function reach(rect: Rect | undefined, metrics: Metrics): { gap: number; label: string } {
  const down = rect ? rect.y - metrics.height : -1;
  const up = rect ? -(rect.y + rect.height) : -1;
  if (down >= 0) return { gap: down, label: `${count(Math.max(1, down))} px down` };
  if (up >= 0) return { gap: up, label: `${count(Math.max(1, up))} px up` };
  return { gap: 0, label: "on screen" };
}

/**
 * The elements anywhere on the page whose name and text together hold every word of `query` (any case), nearest to the
 * screen first, as their lines with where they are in parentheses: `(on screen)`, `(<n> px down)` or `(<n> px up)`;
 * `extra` counts the matches past the limit.
 */
export function search(tree: Array<AriaNode | string>, metrics: Metrics, query: string): { hits: string[]; extra: number } {
  const wanted = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = outline(tree, false)
    .filter((e) => e.ref)
    .filter((e) => {
      const words = `${e.name}\n${e.text}`.toLowerCase();
      return wanted.every((w) => words.includes(w));
    })
    .map((e, order) => ({ e, order, ...reach(e.rect, metrics) }))
    .sort((x, y) => x.gap - y.gap || x.order - y.order);
  return { hits: found.slice(0, SEARCH_LIMIT).map((f) => `${describe(f.e)} (${f.label})`), extra: Math.max(0, found.length - SEARCH_LIMIT) };
}

// ---- Full text ---------------------------------------------------------------------------------------------------

/** The node that carries `ref`, frames included. */
export function findRef(nodes: Array<AriaNode | string>, ref: string): AriaNode | undefined {
  const queue = [...nodes];
  while (queue.length) {
    const node = queue.shift()!;
    if (typeof node === "string") continue;
    if (node.ref === ref) return node;
    if (node.children) queue.unshift(...node.children);
  }
  return undefined;
}

/** Whether a node's words run on in a sentence: a phrase holding phrases only. */
const runsOn = (node: AriaNode | string): boolean =>
  typeof node === "string" || (is(node.role, "phrase") && (node.children ?? []).every((c) => typeof c === "string" || runsOn(c)));

/** The blocks of a node's text, one per line: `#`-headings, `- ` list items, ` | `-joined table cells, paragraphs. */
function* blocks(node: AriaNode | string): Generator<string> {
  if (typeof node === "string") {
    if (squash(node)) yield squash(node);
    return;
  }
  const children = node.children ?? [];
  if (node.role === "heading") return yield `${"#".repeat(Math.max(1, Math.min(6, node.level ?? 1)))} ${wordsOf(node, false)}`;
  if (node.role === "row") return yield children.filter((c) => typeof c !== "string").map((c) => wordsOf(c, false)).join(" | ");
  if (node.role === "listitem" && children.every(runsOn)) return yield `- ${wordsOf(node, false)}`;
  if (node.text !== undefined) return yield squash(node.text) || squash(node.name ?? "");
  if (!children.length) {
    if (node.name) yield squash(node.name);
    return;
  }
  // Words and phrases next to each other make one line; anything else is a block of its own.
  let run: Array<AriaNode | string> = [];
  for (const child of [...children, null]) {
    if (child !== null && runsOn(child)) {
      run.push(child);
      continue;
    }
    const line = sentence(run.map((r) => wordsOf(r, false)));
    if (line) yield line;
    run = [];
    if (child !== null) yield* blocks(child);
  }
}

/** An element's whole text as plain text, one block per line. */
export function fullText(node: AriaNode | string): string {
  return [...blocks(node)].filter((b) => b.trim()).join("\n");
}

/**
 * Part of `text`: at most `max` characters from `offset`, cut where a space follows (unless one word fills the part),
 * then a blank line and a footer in brackets: the characters given and the total, then either the call for the next
 * part (`next: get_text <ref> offset=<to>`) or `end of text`. Numbers in plain digits. Parts read in turn join up to
 * the whole text.
 */
export function excerpt(text: string, ref: string, offset: number, max: number): string {
  const total = text.length;
  const from = Math.max(0, Math.min(total, Math.floor(offset)));
  let to = Math.min(total, from + Math.max(1, Math.floor(max)));
  if (to < total) {
    let cut = to;
    while (cut > from && !/\s/.test(text[cut])) cut--;
    if (cut > from) to = cut;
  }
  const then = to < total ? `next: get_text ${ref} offset=${to}` : "end of text";
  return `${text.slice(from, to)}\n\n[characters ${from}–${to} of ${total}; ${then}]`;
}
