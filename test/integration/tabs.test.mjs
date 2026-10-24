import test from "node:test";
import assert from "node:assert/strict";
import { CDP, closeTabs, connectMcp, fixture, tabs } from "./helpers.mjs";

/**
 * A session follows a tab, and that tab is the one in front: a tab left in the background does not paint, so a
 * screenshot of it waits until it times out. Set up as a person might leave the browser: several tabs, the one the
 * server will pick behind another.
 */

test("a session that picks a tab behind others brings it to the front, and its screenshots work", { timeout: 90_000 }, async () => {
  await closeTabs(1);
  // Two more tabs; the newest is the one a new session follows. Then another tab is brought to the front over it.
  for (const p of ["/next", "/form"]) await fetch(`${CDP}/json/new?${fixture.url(p)}`, { method: "PUT" });
  const first = (await tabs()).find((t) => !t.url.endsWith("/form"));
  await fetch(`${CDP}/json/activate/${first.id}`);
  const mcp = await connectMcp();
  try {
    for (let i = 0; i < 3; i++) {
      await mcp.call("browser_navigate", { url: fixture.url(`/form?try=${i}`) });
      const started = Date.now();
      const shot = await mcp.call("browser_screenshot", {}, true);
      assert.ok(!shot.isError, `screenshot ${i}: ${JSON.stringify(shot.content?.[0]?.text ?? "").slice(0, 200)}`);
      assert.equal(shot.content[0].type, "image");
      assert.ok(Date.now() - started < 5000, `screenshot ${i} took ${Date.now() - started} ms`);
    }
  } finally {
    await mcp.close();
    await closeTabs(1);
  }
});
