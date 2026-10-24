import type { CDPSession } from "playwright-core";

/**
 * The cursor: a pointer drawn into the page where each action lands, so that a person watching the browser, and the
 * model in screenshots, can follow along. On unless BROWSER_CURSOR=0, which turns it off completely: nothing is drawn
 * and nothing is put into any page.
 *
 * Keeping out of the page's way:
 * - Its script runs in an isolated world (CDP Page.addScriptToEvaluateOnNewDocument with a worldName). The page shares
 *   the DOM with it but none of its variables, so the page's scripts can neither reach it nor drive it.
 * - It draws inside a closed shadow root on <body>; a <slot> in that root shows the body's own children as before. The
 *   page's selectors do not reach into a closed root and its styles do not apply there, and the layout stays the same.
 *   (If <body> already has a shadow root, a host element of ours under <html> is used instead.)
 * - Its stage is a manual popover, so it sits in the top layer over all the page draws, and it takes no pointer events.
 * - In the page's own world there is only the test hook `window.__agentCursor.where()`. It asks the cursor for its tip
 *   with an event on window, and the cursor answers in an attribute on <html> that the hook reads and removes at once.
 *
 * The pointer moves to each target in about a third of a second, leaving a dotted line behind; a dark tag under it
 * says what is going on (the field typed into, never the text); a click sends a ring out from the tip; and a blinking
 * caret shows beside it while it types.
 */

export const cursorEnabled = (): boolean => process.env.BROWSER_CURSOR !== "0";

const WORLD = "sandboxed-browser-mcp-pointer";
const ASK = "sbm-pointer-ask";
const ANSWER = "data-sbm-pointer";
export const GLIDE_MS = 320;

/** The pointer itself, run in its own world in every top-level document. */
const POINTER = String.raw`(() => {
  if (window.top !== window || globalThis.__sbmPointer) return;
  const MS = ${GLIDE_MS};
  const pos = { x: null, y: null };
  let parts = null;
  let fadeTimer = 0;

  const STYLE = ${JSON.stringify(`
    [popover].stage { position: fixed; inset: 0; margin: 0; padding: 0; border: none; width: 100vw; height: 100vh; max-width: none;
      max-height: none; overflow: hidden; background: none; pointer-events: none; contain: strict; color-scheme: light; }
    .stage::backdrop { background: none; }
    .hand { position: absolute; top: 0; left: 0; width: 0; height: 0; }
    .hand svg { position: absolute; top: -2px; left: -3px; width: 30px; height: 40px; overflow: visible;
      filter: drop-shadow(0 3px 5px rgba(8, 30, 70, .4)); }
    .tag { position: absolute; top: 42px; left: 10px; display: none; padding: 3px 10px 4px; border-radius: 999px;
      background: rgba(17, 20, 28, .88); color: #f4f7ff; font: 600 12.5px/17px ui-sans-serif, system-ui, sans-serif;
      letter-spacing: .01em; white-space: nowrap; max-width: 300px; overflow: hidden; text-overflow: ellipsis;
      box-shadow: 0 3px 10px rgba(0, 0, 0, .3); opacity: 1; }
    .tag.shown { display: block; }
    .tag.leaving { opacity: 0; transition: opacity .4s ease-in; }
    .caret { position: absolute; top: 20px; left: 24px; width: 3px; height: 16px; border-radius: 2px; display: none;
      background: #2f7bff; animation: caret 0.9s steps(2, start) infinite; }
    .caret.shown { display: block; }
    @keyframes caret { to { visibility: hidden; } }
    .ring { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
      border: 2.5px solid rgba(47, 123, 255, .85); box-sizing: border-box; animation: ring .5s ease-out forwards; }
    @keyframes ring { from { transform: scale(.15); opacity: .95; } to { transform: scale(1.3); opacity: 0; } }
    .path { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  `)};

  const HAND = '<svg viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><radialGradient id="glass" cx=".35" cy=".25" r=".9">' +
    '<stop offset="0" stop-color="#d8e8ff" stop-opacity=".95"/><stop offset=".45" stop-color="#5d9cff" stop-opacity=".75"/>' +
    '<stop offset="1" stop-color="#1f5fd6" stop-opacity=".85"/></radialGradient></defs>' +
    '<path d="M3 2 L3 29.5 L10 23 L14.8 33.5 L19.6 31.4 L14.9 21.2 L24.5 21.2 Z" fill="url(#glass)" stroke="#ffffff" ' +
    'stroke-opacity=".95" stroke-width="1.8" stroke-linejoin="round"/>' +
    '<ellipse cx="7.2" cy="11" rx="1.6" ry="5" fill="#ffffff" fill-opacity=".55" transform="rotate(-8 7.2 11)"/></svg>';

  function build() {
    const body = document.body;
    if (!body) return null;
    let root;
    try {
      root = body.attachShadow({ mode: "closed" });
      root.appendChild(document.createElement("slot"));
    } catch {
      const host = document.createElement("sbm-pointer");
      host.setAttribute("style", "position: fixed !important; inset: 0 !important; pointer-events: none !important;");
      root = host.attachShadow({ mode: "closed" });
      document.documentElement.appendChild(host);
    }
    const sheet = document.createElement("style");
    sheet.textContent = STYLE;
    const stage = document.createElement("div");
    stage.className = "stage";
    stage.setAttribute("popover", "manual");
    stage.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    path.setAttribute("class", "path");
    const hand = document.createElement("div");
    hand.className = "hand";
    hand.innerHTML = HAND;
    const caret = document.createElement("i");
    caret.className = "caret";
    const tag = document.createElement("span");
    tag.className = "tag";
    hand.append(caret, tag);
    stage.append(path, hand);
    root.append(sheet, stage);
    try { stage.showPopover(); } catch {}
    if (pos.x === null) { pos.x = innerWidth / 2; pos.y = innerHeight / 2; }
    return { body, stage, hand, tag, caret, path };
  }

  /** The parts, built or rebuilt when the page replaced its body; null before there is a body. */
  function ready() {
    if (parts && parts.stage.isConnected && parts.body === document.body) {
      if (!parts.stage.matches(":popover-open")) { try { parts.stage.showPopover(); } catch {} }
      return parts;
    }
    parts = build();
    if (parts) put();
    return parts;
  }
  const at = (x, y) => "translate(" + x + "px, " + y + "px)";
  function put() { if (parts) parts.hand.style.transform = at(pos.x, pos.y); }
  /** Over whatever the page has put in the top layer since. */
  function lift() { try { parts.stage.hidePopover(); parts.stage.showPopover(); } catch {} }

  function caption(text) {
    if (!ready()) return;
    clearTimeout(fadeTimer);
    parts.tag.classList.remove("leaving");
    parts.tag.textContent = text || "";
    parts.tag.classList.toggle("shown", !!text);
    // Taken down in the end even when nobody says the action is over (a call given up at its time limit).
    fadeTimer = setTimeout(finish, 15000);
  }
  function moveTo(x, y, text) {
    if (!ready()) return Promise.resolve();
    lift();
    caption(text);
    const ns = "http://www.w3.org/2000/svg";
    const line = document.createElementNS(ns, "line");
    for (const [k, v] of [["x1", pos.x], ["y1", pos.y], ["x2", x], ["y2", y], ["stroke", "#2f7bff"], ["stroke-opacity", ".6"],
      ["stroke-width", "2.5"], ["stroke-linecap", "round"], ["stroke-dasharray", "0 9"]]) line.setAttribute(k, String(v));
    parts.path.replaceChildren(line);
    // Stepped by a timer against the clock, not by animation frames: where frames come slowly (a desktop nobody
    // watches), the tip is still where the time says, and the move still ends on time.
    const from = { x: pos.x, y: pos.y };
    const started = performance.now();
    return new Promise((done) => {
      const step = setInterval(() => {
        const t = Math.min(1, (performance.now() - started) / MS);
        const eased = t * t * (3 - 2 * t);
        pos.x = from.x + (x - from.x) * eased;
        pos.y = from.y + (y - from.y) * eased;
        put();
        if (t < 1) return;
        clearInterval(step);
        if (parts) parts.path.replaceChildren();
        done();
      }, 16);
    });
  }
  function place(x, y) {
    if (x !== null && y !== null) { pos.x = x; pos.y = y; }
    if (ready()) put();
  }
  function tap() {
    if (!ready()) return;
    const ring = document.createElement("b");
    ring.className = "ring";
    ring.style.left = pos.x + "px";
    ring.style.top = pos.y + "px";
    parts.stage.appendChild(ring);
    setTimeout(() => ring.remove(), 700);
  }
  function writing(on) { if (ready()) parts.caret.classList.toggle("shown", !!on); }
  /** The action is over: the tag stays a moment, then fades out. */
  function finish() {
    if (!parts) return;
    parts.caret.classList.remove("shown");
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      parts.tag.classList.add("leaving");
      parts.tag.classList.remove("shown");
    }, 1100);
  }
  /** The tip this moment, mid-move included. */
  function tip() {
    return pos.x === null ? null : { x: pos.x, y: pos.y };
  }
  window.addEventListener(${JSON.stringify(ASK)}, () => {
    const t = tip();
    if (t) document.documentElement.setAttribute(${JSON.stringify(ANSWER)}, Math.round(t.x * 10) / 10 + " " + Math.round(t.y * 10) / 10);
  });
  globalThis.__sbmPointer = { moveTo, place, caption, tap, writing, finish, tip };
})();`;

/** The test hook, in the page's own world. */
const PROBE = String.raw`(() => {
  if (window.top !== window || "__agentCursor" in window) return;
  class Probe {
    where() {
      const html = document.documentElement;
      window.dispatchEvent(new CustomEvent(${JSON.stringify(ASK)}));
      const said = html.getAttribute(${JSON.stringify(ANSWER)});
      html.removeAttribute(${JSON.stringify(ANSWER)});
      if (!said) return null;
      const [x, y] = said.split(" ").map(Number);
      return { x, y };
    }
  }
  Object.defineProperty(window, "__agentCursor", { value: Object.freeze(new Probe()) });
})();`;

/** Sessions the pointer's scripts were added to, so that a new document gets them too. */
const installed = new WeakMap<CDPSession, Promise<void>>();

async function install(session: CDPSession): Promise<void> {
  let ready = installed.get(session);
  if (!ready) {
    ready = (async () => {
      await session.send("Page.addScriptToEvaluateOnNewDocument", { source: POINTER, worldName: WORLD });
      await session.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
    })();
    installed.set(session, ready);
    ready.catch(() => installed.delete(session));
  }
  await ready;
}

/** Runs `expression` in the pointer's world of the tab's current document, setting the pointer up there first if needed. */
async function inWorld(session: CDPSession, expression: string, waitMs = 0): Promise<unknown> {
  await install(session);
  const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
  const { executionContextId } = (await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD })) as { executionContextId: number };
  // A document from before the scripts were added has neither part yet.
  await session.send("Runtime.evaluate", { expression: POINTER, contextId: executionContextId });
  await session.send("Runtime.evaluate", { expression: PROBE });
  const run = session.send("Runtime.evaluate", { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true });
  const result = (await (waitMs ? Promise.race([run, new Promise((r) => setTimeout(r, waitMs))]) : run)) as { result?: { value?: unknown } } | undefined;
  return result?.result?.value;
}

/** A call on the pointer in the page, as an expression. */
const invoke = (method: string, ...args: unknown[]) => `globalThis.__sbmPointer?.${method}(${args.map((a) => JSON.stringify(a ?? null)).join(", ")})`;

/**
 * The pointer of one session. Each method does nothing when the cursor is off, and never fails an action: a pointer
 * that cannot be drawn (a page going away, a document still loading) is left out, not reported.
 */
export class Cursor {
  /** Where the tip was last put, in viewport pixels; carried to the next page and tab. */
  x: number | null = null;
  y: number | null = null;

  private async run(session: CDPSession | undefined, expression: string, waitMs = 1500): Promise<unknown> {
    if (!cursorEnabled() || !session) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A page that does not answer (a script in an endless loop) does not hold the action up for long.
    const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), waitMs + 500)));
    try {
      return await Promise.race([inWorld(session, expression, waitMs).catch(() => undefined), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Moves the tip to (x, y) with `label` showing, and resolves when it is there. */
  async glide(session: CDPSession | undefined, x: number, y: number, label: string): Promise<void> {
    if (!cursorEnabled()) return;
    await this.run(session, `${invoke("place", this.x, this.y)}, ${invoke("moveTo", x, y, label)}`, GLIDE_MS + 700);
    [this.x, this.y] = [x, y];
  }

  /** Shows `label` where the tip is. */
  async say(session: CDPSession | undefined, label: string): Promise<void> {
    await this.run(session, `${invoke("place", this.x, this.y)}, ${invoke("caption", label)}`);
  }

  async ripple(session: CDPSession | undefined): Promise<void> {
    await this.run(session, invoke("tap"));
  }

  async typing(session: CDPSession | undefined, on: boolean): Promise<void> {
    await this.run(session, invoke("writing", on));
  }

  /** The action is over: the label fades a moment later. */
  async done(session: CDPSession | undefined): Promise<void> {
    await this.run(session, invoke("finish"));
  }

  /** Puts the pointer back where it was, on a page that has just loaded (or a tab just followed). */
  async restore(session: CDPSession | undefined): Promise<void> {
    if (this.x === null || this.y === null) return;
    await this.run(session, invoke("place", this.x, this.y));
  }
}
