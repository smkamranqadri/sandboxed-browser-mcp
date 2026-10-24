import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { stopGuard } from "../../dist/navguard.js";
import { browserTools, disconnect, runCall } from "../../dist/tools.js";
import { fakeBrowser } from "./fake-browser.mjs";

/**
 * A call given up at its time limit (src/server.ts) while one step of a tool ran does not go on to the next step: a
 * type that times out while it fills does not then press Enter, a click whose element is slow to be found is not
 * clicked, a navigation slow to start is not started. Against a fake page (no browser), whose steps the test holds and
 * lets go.
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

const locator = {
  count: async () => (await step("find"), 1),
  fill: () => step("fill"),
  press: (key) => step(`press ${key}`),
  click: () => step("click"),
  selectOption: () => step("select"),
  scrollIntoViewIfNeeded: () => step("scroll into view"),
};
/**
 * A tab. A new one has its target id asked for again (tools.ts keeps it per page). `goto` goes where it is sent, except
 * that /bounce redirects to a host off the allowlist.
 */
const makePage = () => {
  let at = "http://allowed.fixture.test/form";
  return {
  isClosed: () => false,
  context: () => context,
  url: () => at,
  ariaSnapshotJSON: async () => [],
  evaluate: async (fn) => (String(fn).includes("scrollHeight") ? { width: 800, height: 600, scrollY: 0, scrollHeight: 600 } : undefined),
  title: async () => "Pinewood Seeds",
  locator: () => locator,
  mouse: { move: () => step("move"), wheel: () => step("wheel") },
  goto: async (url) => {
    await step("goto");
    at = url.endsWith("/bounce") ? "http://blocked.example.net/secret" : url;
  },
  goBack: () => step("back"),
  waitForTimeout: async () => {},
  waitForLoadState: async () => {},
  bringToFront: async () => {},
  };
};
let current = makePage();
const context = {
  pages: () => [current],
  on: () => {},
  off: () => {},
  newCDPSession: async () => (await step("target id"), { send: async () => ({ targetInfo: { targetId: "fixture-tab" } }), detach: async () => {} }),
};
chromium.connectOverCDP = async () => ({ isConnected: () => true, contexts: () => [context], on: () => {}, close: async () => {} });

after(() => disconnect());

let sessions = 0;
/** Runs `name` with `args` in a new session on a new tab, gives it up while `held` is held, lets that go, and returns what was done after. */
async function abandonDuring(name, args, held) {
  current = makePage();
  const tools = new Map(browserTools(`unit-abandon-${++sessions}`).map((d) => [d.name, d]));
  await tools.get("browser_snapshot").execute("call", {});
  done.length = 0;
  holding = new Set([held]);
  const call = runCall(() => tools.get(name).execute("call", args));
  const deadline = Date.now() + 5000;
  while (!holds.has(held)) {
    assert.ok(Date.now() < deadline, `${name} never reached the step "${held}": ${JSON.stringify(done)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  call.abandon();
  holds.get(held)();
  holds.delete(held);
  holding = new Set();
  await assert.rejects(call.result, /^Error: This call ran past its time limit and was abandoned\.$/);
  // The target id is asked for alongside an action, not as a step of it.
  return done.slice(done.indexOf(held) + 1).filter((s) => s !== "target id");
}

test("a type given up while it fills does not press Enter after", async () => {
  assert.deepEqual(await abandonDuring("browser_type", { ref: "e1", text: "Rowan Vale", submit: true }, "fill"), []);
});

test("a type given up while its field is found does not fill it", async () => {
  assert.deepEqual(await abandonDuring("browser_type", { ref: "e1", text: "Rowan Vale" }, "find"), []);
});

test("a click given up while its element is found does not click", async () => {
  assert.deepEqual(await abandonDuring("browser_click", { ref: "e1" }, "find"), []);
});

test("a choice given up while its dropdown is found does not choose", async () => {
  assert.deepEqual(await abandonDuring("browser_select", { ref: "e1", option: "Pro" }, "find"), []);
});

test("a scroll to an element given up while it is found does not scroll", async () => {
  assert.deepEqual(await abandonDuring("browser_scroll", { ref: "e1" }, "find"), []);
});

test("a scroll given up while the pointer moves does not turn the wheel", async () => {
  assert.deepEqual(await abandonDuring("browser_scroll", {}, "move"), []);
});

test("a navigation or a back given up before it starts is not started", async () => {
  assert.deepEqual(await abandonDuring("browser_navigate", { url: "http://allowed.fixture.test/next" }, "target id"), []);
  assert.deepEqual(await abandonDuring("browser_back", {}, "target id"), []);
});

test("calls that are not given up do every step", async () => {
  current = makePage();
  const tools = new Map(browserTools("unit-abandon-kept").map((d) => [d.name, d]));
  const run = async (name, args) => {
    done.length = 0;
    await runCall(() => tools.get(name).execute("call", args)).result;
    return done.filter((s) => s !== "target id");
  };
  await run("browser_snapshot", {});
  assert.deepEqual(await run("browser_type", { ref: "e1", text: "Rowan Vale", submit: true }), ["find", "fill", "press Enter"]);
  assert.deepEqual(await run("browser_click", { ref: "e1" }), ["find", "click"]);
  assert.deepEqual(await run("browser_select", { ref: "e1", option: "Pro" }), ["find", "select"]);
  assert.deepEqual(await run("browser_scroll", { ref: "e1" }), ["find", "scroll into view"]);
  assert.deepEqual(await run("browser_scroll", {}), ["move", "wheel"]);
  assert.deepEqual(await run("browser_navigate", { url: "http://allowed.fixture.test/next" }), ["goto"]);
  assert.deepEqual(await run("browser_back", {}), ["back"]);
});

describe("with an allowlist, putting the tab back after a refused navigation", () => {
  // The allowlist needs the guard, and the guard a browser to connect to: a fake one that answers every call.
  let browser;
  before(async () => {
    browser = await fakeBrowser("answer");
    process.env.BROWSER_ALLOWED_HOSTS = "allowed.fixture.test";
  });
  after(async () => {
    stopGuard();
    await browser.close();
    delete process.env.BROWSER_ALLOWED_HOSTS;
  });

  test("given up while it navigated, it does not go back", async () => {
    assert.deepEqual(await abandonDuring("browser_navigate", { url: "http://allowed.fixture.test/bounce" }, "goto"), []);
  });

  test("given up while it went back, it does not go to the address again", async () => {
    // The fake's back does not move the tab, so putting it back would go on to load the address.
    assert.deepEqual(await abandonDuring("browser_navigate", { url: "http://allowed.fixture.test/bounce" }, "back"), []);
  });

  test("not given up, it goes back and then to the address", async () => {
    current = makePage();
    const tools = new Map(browserTools("unit-abandon-restore").map((d) => [d.name, d]));
    await tools.get("browser_snapshot").execute("call", {});
    done.length = 0;
    await assert.rejects(runCall(() => tools.get("browser_navigate").execute("call", { url: "http://allowed.fixture.test/bounce" })).result, /^Error: Blocked: blocked\.example\.net is not on the allowed hosts \(BROWSER_ALLOWED_HOSTS\), and http:\/\/allowed\.fixture\.test\/bounce led there\. You are still on allowed\.fixture\.test\.$/);
    assert.deepEqual(done.filter((s) => s !== "target id"), ["goto", "back", "goto"]);
  });
});
