import test, { after, afterEach, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { RELEASE_LIMIT } from "../../dist/chooser.js";
import { browserTools, disconnect, runCall } from "../../dist/tools.js";

/**
 * File chooser capture around browser_click (src/chooser.ts): armed just before the click, released on every way out,
 * and a release counts only once the browser has confirmed interception is off. Against a fake page whose steps the
 * test holds and lets go, and whose interception switch behaves as Playwright's: adding the first "filechooser"
 * listener or removing the last switches it unawaited, and the page's channel switches only on a change, answering
 * at once when there is none.
 */

process.env.BROWSER_FRAMES = "0";
process.env.BROWSER_CURSOR = "0";
delete process.env.BROWSER_ALLOWED_HOSTS;

/** What the page was made to do, in order. */
const done = [];
/** Steps held until the test lets them go: name → release. */
const holds = new Map();
let holding = new Set();
const step = async (name) => {
  done.push(name);
  if (holding.has(name)) await new Promise((release) => holds.set(name, release));
};
const waitFor = async (name, what = name) => {
  const deadline = Date.now() + 5000;
  while (!holds.has(name) && !done.includes(name)) {
    assert.ok(Date.now() < deadline, `never reached "${what}": ${JSON.stringify(done)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const letGo = (name) => {
  holding.delete(name);
  holds.get(name)?.();
  holds.delete(name);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a click on the fake page does: open no chooser, one now, one after `delay` ms, or (double) one per click. */
let opens = { choosers: 0, delay: 0 };
let clickFails = false;

const makePage = () => {
  const listeners = [];
  // As the browser has it (confirmed), and as Playwright's page dispatcher has it (switched at once, then confirmed).
  let intercepting = false;
  let wanted = false;
  const page = {
    isClosed: () => false,
    context: () => context,
    url: () => "http://allowed.fixture.test/upload",
    ariaSnapshotJSON: async () => [],
    evaluate: async (fn) => (String(fn).includes("scrollHeight") ? { width: 800, height: 600, scrollY: 0, scrollHeight: 600 } : undefined),
    title: async () => "Pinewood Seeds",
    locator: () => locator,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    bringToFront: async () => {},
    _channel: {
      updateSubscription: async ({ event, enabled }) => {
        assert.equal(event, "fileChooser");
        if (enabled === wanted) return;
        wanted = enabled;
        await step(`intercept ${enabled ? "on" : "off"}`);
        intercepting = enabled;
      },
    },
    on: (event, listener) => {
      assert.equal(event, "filechooser");
      if (!listeners.length) void page._channel.updateSubscription({ event: "fileChooser", enabled: true });
      listeners.push(listener);
      return page;
    },
    off: (event, listener) => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
      if (!listeners.length) void page._channel.updateSubscription({ event: "fileChooser", enabled: false });
      return page;
    },
    /** A chooser the page opens: caught by the listeners while intercepted, else the native dialog. */
    openChooser: () => {
      if (!intercepting) return void done.push("native dialog");
      const chooser = { isMultiple: () => false, setFiles: async () => void done.push("setFiles") };
      done.push("chooser");
      for (const l of [...listeners]) l(chooser);
    },
    listeners: () => listeners.length,
    intercepting: () => intercepting,
  };
  return page;
};

const clickOnce = async () => {
  await step("click");
  if (clickFails) throw new Error("locator.click: Timeout 10000ms exceeded.\nCall log:\n  - element is not visible");
  for (let i = 0; i < opens.choosers; i++) {
    if (opens.delay) setTimeout(() => current.openChooser(), opens.delay);
    else current.openChooser();
  }
};
const locator = {
  count: async () => (await step("find"), 1),
  click: clickOnce,
  dblclick: clickOnce,
};

let current = makePage();
const context = {
  pages: () => [current],
  on: () => {},
  off: () => {},
  newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: "fixture-tab" } }), detach: async () => {} }),
};
chromium.connectOverCDP = async () => ({ isConnected: () => true, contexts: () => [context], on: () => {}, close: async () => void done.push("connection closed") });

after(() => disconnect());

let tools;
let sessions = 0;
beforeEach(async () => {
  current = makePage();
  opens = { choosers: 0, delay: 0 };
  clickFails = false;
  holding = new Set();
  tools = new Map(browserTools(`unit-chooser-${++sessions}`).map((d) => [d.name, d]));
  await runCall(() => tools.get("browser_snapshot").execute("call", {})).result;
  done.length = 0;
});

const call = (name, args) => runCall(() => tools.get(name).execute("call", args));
const textOf = async (result) => (await result).content[0].text;
/** The fake page left as before the call: no listener, interception off. */
const clean = () => assert.deepEqual([current.listeners(), current.intercepting()], [0, false]);
/** Whether `promise` is still pending after `ms`. */
const pending = async (promise, ms = 150) => {
  let state = "pending";
  promise.then(() => (state = "resolved"), () => (state = "rejected"));
  await pause(ms);
  return state === "pending";
};

const HINT = "Clicked e4, which opens a file chooser: it was caught, so no dialog opened and no file was chosen. To attach files, use browser_upload on e4. The view looks exactly as before.";

test("a click that opens a chooser: caught, given no files, and the answer names the ref and browser_upload", async () => {
  opens = { choosers: 1, delay: 0 };
  assert.equal(await textOf(call("browser_click", { ref: "e4" }).result), HINT);
  assert.deepEqual(done, ["find", "intercept on", "click", "chooser", "intercept off"]);
  clean();
});

test("a click that opens none answers as before, once the capture is released, a moment after the click", async () => {
  const started = Date.now();
  assert.equal(await textOf(call("browser_click", { ref: "e4" }).result), "Clicked e4. The view looks exactly as before.");
  assert.ok(Date.now() - started >= 950, String(Date.now() - started));
  assert.deepEqual(done, ["find", "intercept on", "click", "intercept off"]);
  clean();
});

test("a chooser opened a moment after the click is caught; one opened after the window gets the native dialog", async () => {
  opens = { choosers: 1, delay: 400 };
  assert.equal(await textOf(call("browser_click", { ref: "e4" }).result), HINT);
  assert.deepEqual(done, ["find", "intercept on", "click", "chooser", "intercept off"]);
  clean();
  done.length = 0;
  opens = { choosers: 1, delay: 1600 };
  assert.equal(await textOf(call("browser_click", { ref: "e4" }).result), "Clicked e4. The view looks exactly as before.");
  await pause(800);
  assert.deepEqual(done, ["find", "intercept on", "click", "intercept off", "native dialog"]);
  clean();
});

test("a double-click that opens two choosers: both caught, one hint, no files", async () => {
  opens = { choosers: 2, delay: 0 };
  assert.equal(await textOf(call("browser_click", { ref: "e4", double: true }).result), HINT.replace("Clicked", "Double-clicked"));
  assert.deepEqual(done, ["find", "intercept on", "click", "chooser", "chooser", "intercept off"]);
  clean();
});

test("a click that fails releases the capture, and answers only once the release is confirmed", async () => {
  clickFails = true;
  holding = new Set(["intercept off"]);
  const { result } = call("browser_click", { ref: "e4" });
  await waitFor("intercept off");
  assert.equal(await pending(result), true);
  letGo("intercept off");
  await assert.rejects(result, /^Error: e4 could not be clicked within 10 s: it never became visible\. A new browser_snapshot shows the page as it is now\.$/);
  assert.deepEqual(done, ["find", "intercept on", "click", "intercept off"]);
  clean();
});

test("the answer waits for the confirmed release: held, the click does not answer, though its listener could go", async () => {
  opens = { choosers: 1, delay: 0 };
  holding = new Set(["intercept off"]);
  const { result } = call("browser_click", { ref: "e4" });
  await waitFor("intercept off");
  assert.equal(await pending(result), true);
  letGo("intercept off");
  assert.equal(await textOf(result), HINT);
  clean();
});

test("the click waits for interception to be confirmed on before it clicks", async () => {
  holding = new Set(["intercept on"]);
  const { result } = call("browser_click", { ref: "e4" });
  await waitFor("intercept on");
  await pause(100);
  assert.deepEqual(done, ["find", "intercept on"]);
  letGo("intercept on");
  await result;
  assert.deepEqual(done, ["find", "intercept on", "click", "intercept off"]);
  clean();
});

/** Gives up a click while `held` is held, lets it go, and checks what followed; the next call then works. */
async function abandonDuring(held, { choosers = 0 } = {}) {
  opens = { choosers, delay: 0 };
  holding = new Set([held]);
  const click = call("browser_click", { ref: "e4" });
  await waitFor(held);
  click.abandon();
  letGo(held);
  await assert.rejects(click.result, /^Error: This call ran past its time limit and was abandoned\.$/);
  const after = done.slice(done.indexOf(held) + 1);
  clean();
  assert.equal(await textOf(call("browser_snapshot", {}).result).then((t) => t.startsWith("Page: Pinewood Seeds")), true);
  return after;
}

test("given up while its element is found: no capture armed, no click", async () => {
  assert.deepEqual(await abandonDuring("find"), []);
});

test("given up while interception is switched on: no click, and the capture is released", async () => {
  assert.deepEqual(await abandonDuring("intercept on"), ["intercept off"]);
});

test("given up during the click: released at once, so a chooser of the late click gets the native dialog; no second click, no files", async () => {
  assert.deepEqual(await abandonDuring("click", { choosers: 1 }), ["intercept off", "native dialog"]);
  assert.deepEqual(done, ["find", "intercept on", "click", "intercept off", "native dialog"]);
});

test("given up while it waits for a chooser: released at once, not at the end of the window", async () => {
  const { result, abandon } = call("browser_click", { ref: "e4" });
  await waitFor("click");
  await pause(50);
  const started = Date.now();
  abandon();
  await assert.rejects(result, /abandoned/);
  assert.ok(Date.now() - started < 900, String(Date.now() - started));
  assert.deepEqual(done, ["find", "intercept on", "click", "intercept off"]);
  clean();
});

test("given up, the next call does not start until the release is confirmed", { timeout: 5000 }, async () => {
  holding = new Set(["click", "intercept off"]);
  const click = call("browser_click", { ref: "e4" });
  await waitFor("click");
  click.abandon();
  letGo("click");
  await waitFor("intercept off");
  // The server's time limit has answered the click by now; the next call comes, and waits behind the release.
  done.length = 0;
  const next = call("browser_click", { ref: "e5" });
  assert.equal(await pending(next.result, 200), true);
  assert.deepEqual(done, []);
  letGo("intercept off");
  await assert.rejects(click.result, /^Error: This call ran past its time limit and was abandoned\.$/);
  assert.equal(await textOf(next.result), "Clicked e5. The view looks exactly as before.");
  assert.deepEqual(done, ["find", "intercept on", "click", "intercept off"]);
  clean();
});

describe("a browser that does not confirm", () => {
  beforeEach(() => (RELEASE_LIMIT.ms = 300));
  afterEach(() => (RELEASE_LIMIT.ms = 10_000));

  test("a release never confirmed: after the limit the connection is dropped, and the next call goes on", { timeout: 5000 }, async () => {
    holding = new Set(["intercept off"]);
    const started = Date.now();
    assert.equal(await textOf(call("browser_click", { ref: "e4" }).result), "Clicked e4. The view looks exactly as before.");
    assert.ok(Date.now() - started < 1000 + 300 + 500, String(Date.now() - started));
    assert.deepEqual(done, ["find", "intercept on", "click", "intercept off", "connection closed"]);
    assert.equal(current.listeners(), 0);
    // A new connection has new page objects for the same tabs, as Playwright gives them.
    holding = new Set();
    current = makePage();
    done.length = 0;
    assert.equal(await textOf(call("browser_click", { ref: "e5" }).result), "Clicked e5. The view looks exactly as before.");
    assert.deepEqual(done, ["find", "intercept on", "click", "intercept off"]);
    clean();
  });

  test("interception never confirmed on: no click, the capture is released, and the call says the browser did not answer", { timeout: 5000 }, async () => {
    holding = new Set(["intercept on"]);
    await assert.rejects(call("browser_click", { ref: "e4" }).result, /^Error: The browser did not answer in time, so nothing was clicked\. Try again, or tell the user\.$/);
    assert.deepEqual(done, ["find", "intercept on", "intercept off"]);
    assert.equal(current.listeners(), 0);
  });
});
