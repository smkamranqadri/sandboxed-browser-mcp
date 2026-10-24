import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { cdpUp, closeTabs, compose, connectMcp, fixture, refOf, setPolicy, tabs } from "./helpers.mjs";

/**
 * The browser's own policy (docker/policy.sh), which holds while the server's guard (src/navguard.ts) is not
 * connected: here, while the CDP relay is stopped, so that no CDP client can reach the browser at all. The same page
 * leaves for the blocked host in that window twice: without the policy it gets there (the gap), with it it does not.
 */

const ALLOWED = "allowed.fixture.test";

/** Opens /later-slow through the server, stops the relay before the page leaves, and starts it again once it has. */
async function leaveWhileUnguarded(mcp) {
  await mcp.call("browser_navigate", { url: fixture.url("/later-slow") });
  await fixture.reset();
  await compose("stop", "cdp-relay");
  const deadline = Date.now() + 15_000;
  while (!(await fixture.hits()).allowed.includes("/leaving") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.ok((await fixture.hits()).allowed.includes("/leaving"), "the page set off while the relay was down");
  await new Promise((r) => setTimeout(r, 1500));
  const hits = await fixture.hits();
  await compose("start", "cdp-relay");
  await cdpUp();
  return hits;
}

describe("the browser's policy holds while the guard is down", { timeout: 180_000 }, () => {
  before(async () => {
    await closeTabs(1);
    await setPolicy("");
  });
  after(async () => {
    await compose("start", "cdp-relay").catch(() => {});
    await cdpUp().catch(() => {});
    await setPolicy("");
  });

  test("without the policy, a page that leaves while the guard is down reaches the disallowed host (the gap)", async () => {
    const mcp = await connectMcp({ BROWSER_ALLOWED_HOSTS: ALLOWED });
    try {
      const hits = await leaveWhileUnguarded(mcp);
      assert.deepEqual(hits.blocked.filter((u) => u === "/secret"), ["/secret"]);
    } finally {
      await mcp.close();
    }
  });

  test("with the policy, the same page does not reach it, and the tools refuse the tab it was left on", async () => {
    await closeTabs(1);
    await setPolicy(ALLOWED);
    const mcp = await connectMcp({ BROWSER_ALLOWED_HOSTS: ALLOWED });
    try {
      const hits = await leaveWhileUnguarded(mcp);
      assert.deepEqual(hits.blocked, [], "the blocked host received nothing");
      assert.equal((await tabs()).at(-1).url, fixture.blockedUrl(), "the tab shows the browser's refusal at that address");
      const look = await mcp.call("browser_snapshot", {}, true);
      assert.equal(look.isError, true);
      // A connection made after the refusal sees the browser's error page by its own address, not the refused one.
      assert.match(mcp.text(look), /^The tab is on a chrome-error: address, which is not an allowed host \(BROWSER_ALLOWED_HOSTS\)/);
    } finally {
      await mcp.close();
    }
  });

  test("with the policy and the guard both up, the tools answer a refusal as before", async () => {
    await closeTabs(1);
    const mcp = await connectMcp({ BROWSER_ALLOWED_HOSTS: ALLOWED });
    try {
      await fixture.reset();
      await mcp.call("browser_navigate", { url: fixture.url("/") });
      const clicked = await mcp.call("browser_click", { ref: refOf(await mcp.call("browser_snapshot"), /link "Partner shop"(?! \(new tab\))/) });
      assert.match(clicked, /: blocked\. http:\/\/blocked\.fixture\.test\/secret is not on the allowed hosts \(BROWSER_ALLOWED_HOSTS\) and was not loaded\. You are still on http:\/\/allowed\.fixture\.test\/\./);
      const nav = await mcp.call("browser_navigate", { url: fixture.url("/bounce") }, true);
      assert.equal(nav.isError, true);
      assert.match(mcp.text(nav), /^Blocked: blocked\.fixture\.test is not on the allowed hosts \(BROWSER_ALLOWED_HOSTS\), and http:\/\/allowed\.fixture\.test\/bounce led there\. You are still on allowed\.fixture\.test\.$/);
      assert.deepEqual((await tabs()).map((t) => t.url), [fixture.url("/")]);
      assert.deepEqual((await fixture.hits()).blocked, []);
    } finally {
      await mcp.close();
    }
  });
});
