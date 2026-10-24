import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ensureGuard, stopGuard } from "../../dist/navguard.js";
import { browserTools, runCall, stillWanted, ToolError } from "../../dist/tools.js";
import { fakeBrowser } from "./fake-browser.mjs";

/**
 * The guard's connection against a fake browser: an HTTP server with /json/version and a websocket that answers CDP
 * calls as the test says (or never), so that timeouts and reconnects are checked without a browser.
 */

const until = async (check, ms) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return check();
};

let browser;
afterEach(async () => {
  stopGuard();
  await browser?.close();
  browser = undefined;
  delete process.env.BROWSER_CDP_URL;
  delete process.env.BROWSER_ALLOWED_HOSTS;
});

test("a websocket that never opens fails the guard's set-up at its time limit, and the next try starts afresh", { timeout: 10_000 }, async () => {
  browser = await fakeBrowser("silent");
  const started = Date.now();
  await assert.rejects(ensureGuard(["allowed.test"], 300), /^Error: the debugging websocket did not open within 300 ms$/);
  assert.ok(Date.now() - started < 2000, `failed at the time limit: ${Date.now() - started} ms`);
  await assert.rejects(ensureGuard(["allowed.test"], 300), /did not open within 300 ms/);
  assert.equal(browser.connections(), 2, "the second call tried again instead of waiting on the first");
});

test("a browser that opens the websocket and never answers fails the set-up at its time limit", { timeout: 10_000 }, async () => {
  browser = await fakeBrowser("mute");
  const started = Date.now();
  await assert.rejects(ensureGuard(["allowed.test"], 300), /^Error: the browser did not answer Target\.setAutoAttach within 300 ms$/);
  assert.ok(Date.now() - started < 2000, `failed at the time limit: ${Date.now() - started} ms`);
});

test("a guard whose connection drops is set up again without waiting for a call, and not after it is stopped", { timeout: 10_000 }, async () => {
  browser = await fakeBrowser("answer");
  await ensureGuard(["allowed.test"], 1000);
  assert.equal(browser.connections(), 1);
  browser.drop();
  assert.ok(await until(() => browser.connections() === 2, 3000), `reconnected by itself: ${browser.connections()} connections`);
  stopGuard();
  browser.drop();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(browser.connections(), 2, "a stopped guard stays stopped");
});

test("a tab still there whose interception fails fails the set-up with the browser's error, and the guard is set up again", { timeout: 10_000 }, async () => {
  browser = await fakeBrowser("answer", { tabs: 1, failFetch: true });
  await assert.rejects(ensureGuard(["allowed.test"], 1000), /^Error: Fetch\.enable failed on a fixture tab$/);
  assert.ok(await until(() => browser.connections() === 2, 6000), `tried again by itself: ${browser.connections()} connections`);
});

test("a tab that comes later and cannot be intercepted drops the guard's connection, which is set up again", { timeout: 10_000 }, async () => {
  browser = await fakeBrowser("answer", { failFetch: true });
  await ensureGuard(["allowed.test"], 1000);
  assert.equal(browser.connections(), 1);
  browser.attach("late");
  assert.ok(await until(() => browser.connections() === 2, 6000), `set up again: ${browser.connections()} connections`);
});

test("a tab that went away while it was set up does not fail the guard", { timeout: 10_000 }, async () => {
  // Told by its detachment, or by the browser's answer when that comes first.
  for (const gone of [{ failFetch: true, detachFirst: true }, { failFetch: "Session with given id not found." }]) {
    browser = await fakeBrowser("answer", { tabs: 1, ...gone });
    await ensureGuard(["allowed.test"], 1000);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(browser.connections(), 1, `the connection was kept: ${JSON.stringify(gone)}`);
    stopGuard();
    await browser.close();
  }
  browser = undefined;
});

test("a guard stopped while it connects does not take over afterwards, nor set itself up again", { timeout: 10_000 }, async () => {
  browser = await fakeBrowser("answer");
  const starting = ensureGuard(["allowed.test"], 1000);
  stopGuard();
  await assert.rejects(starting, /^Error: the guard was stopped while it was being set up$/);
  browser.drop();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(browser.connections(), 1, "no connection after the stop");
});

test("a browser that cannot be reached for the allowlist is the server's own message, not the browser's words", { timeout: 10_000 }, async () => {
  // A port nothing listens on: taken, then let go.
  const free = createServer();
  await new Promise((r) => free.listen(0, "127.0.0.1", r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  process.env.BROWSER_CDP_URL = `http://127.0.0.1:${port}`;
  process.env.BROWSER_ALLOWED_HOSTS = "allowed.test";
  const snapshot = browserTools("unit").find((d) => d.name === "browser_snapshot");
  await assert.rejects(snapshot.execute("call", {}), (e) => {
    assert.ok(e instanceof ToolError, `a ToolError: ${e}`);
    assert.match(e.message, new RegExp(`^The browser is not reachable at http://127\\.0\\.0\\.1:${port} to apply BROWSER_ALLOWED_HOSTS \\(fetch failed\\), so nothing was done\\.`));
    return true;
  });
});

test("an abandoned call stops at its next step; one that is not goes on", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const late = runCall(async () => {
    await gate;
    stillWanted();
    return "went on";
  });
  late.abandon();
  release();
  await assert.rejects(late.result, (e) => e instanceof ToolError && e.message === "This call ran past its time limit and was abandoned.");

  const kept = runCall(async () => {
    await new Promise((r) => setTimeout(r, 10));
    stillWanted();
    return "went on";
  });
  assert.equal(await kept.result, "went on");
  // Outside any call, nothing is abandoned.
  assert.doesNotThrow(stillWanted);
});
