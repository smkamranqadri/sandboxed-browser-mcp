import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { closeObservers, closeTabs, connectMcp, fixture, observe, refOf } from "./helpers.mjs";

/**
 * The cursor drawn into the page (src/cursor.ts), seen from outside: where its tip is (the page's test hook), whether it
 * passes through the points between, whether the page can see or hide it, and what the screen shows, compared region by
 * region in lossless captures of the browser's own (a region with the arrow differs from a blank one; two blank ones
 * are the same bytes).
 */

/** The followed tab as a second client sees it, by its address. */
async function tabAt(url) {
  const browser = await observe();
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 100))) {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url() === url);
    if (page) return page;
  }
  throw new Error(`no tab at ${url}`);
}

/** A PNG of a square of the screen at (x, y), as the browser draws it. */
async function region(page, x, y, size = 40) {
  const cdp = await page.context().newCDPSession(page);
  try {
    return (await cdp.send("Page.captureScreenshot", { format: "png", clip: { x, y, width: size, height: size, scale: 1 } })).data;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

const centreOf = (page, selector) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
const where = (page) => page.evaluate(() => (window.__agentCursor ? window.__agentCursor.where() : "none"));
/** A corner of the window with nothing of the fixture's cursor pages in it. */
const BLANK = { x: 900, y: 560 };

describe("the cursor (on by default)", () => {
  let mcp;
  before(async () => {
    await closeTabs(1);
    mcp = await connectMcp({});
  });
  after(async () => {
    await mcp?.close();
    await closeObservers();
  });

  test("after a click its tip is on the middle of what was clicked", async () => {
    const view = await mcp.call("browser_navigate", { url: fixture.url("/cursor/3") });
    await mcp.call("browser_click", { ref: refOf(view, /button "Press 3"/) });
    const page = await tabAt(fixture.url("/cursor/3"));
    const tip = await where(page);
    const centre = await centreOf(page, "#go");
    assert.ok(Math.abs(tip.x - centre.x) <= 4 && Math.abs(tip.y - centre.y) <= 4, `tip ${JSON.stringify(tip)}, centre ${JSON.stringify(centre)}`);
  });

  test("it glides: during an action the tip passes the points between where it was and the target", async () => {
    const view = await mcp.call("browser_navigate", { url: fixture.url("/cursor/5") });
    const page = await tabAt(fixture.url("/cursor/5"));
    const start = await where(page);
    const target = await centreOf(page, "#field");
    const seen = [];
    let done = false;
    const typing = mcp.call("browser_type", { ref: refOf(view, /textbox "Field 5"/), text: "not shown in any label" }).finally(() => (done = true));
    while (!done) {
      const at = await where(page).catch(() => null);
      if (at && at !== "none") seen.push(at);
      await new Promise((r) => setTimeout(r, 15));
    }
    await typing;
    const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) > 15;
    assert.ok(far(start, target), "the field is away from where the tip was");
    assert.ok(seen.some((p) => far(p, start) && far(p, target)), `a point on the way: ${JSON.stringify(seen.slice(0, 40))}`);
    const end = await where(page);
    assert.ok(Math.abs(end.x - target.x) <= 4 && Math.abs(end.y - target.y) <= 4);
  });

  test("it survives navigation: on the next page it is where it was", async () => {
    const view = await mcp.call("browser_navigate", { url: fixture.url("/cursor/6") });
    await mcp.call("browser_click", { ref: refOf(view, /button "Press 6"/) });
    const before = await where(await tabAt(fixture.url("/cursor/6")));
    await mcp.call("browser_navigate", { url: fixture.url("/cursor/7") });
    const after = await where(await tabAt(fixture.url("/cursor/7")));
    assert.ok(Math.abs(after.x - before.x) <= 1 && Math.abs(after.y - before.y) <= 1, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  });

  test("the page cannot see it, and its own styles do not hide it; the screen shows it", async () => {
    const view = await mcp.call("browser_navigate", { url: fixture.url("/cursor/8") });
    await mcp.call("browser_click", { ref: refOf(view, /button "Press 8"/) });
    const page = await tabAt(fixture.url("/cursor/8"));
    const seen = await page.evaluate(() => ({ tags: [...document.querySelectorAll("*")].map((e) => e.localName).join(","), shadow: document.body.shadowRoot }));
    assert.equal(seen.tags, "html,head,meta,title,body,h1,div,button,p,label,input,p,label,select,option,option,option,p,a");
    assert.equal(seen.shadow, null);
    // The page hides everything of its own; a scroll brings the tip to the middle of the window, which is then blank but for it.
    await page.addStyleTag({ content: "body * { display: none !important; } [popover], :popover-open, div { display: none !important; opacity: 0 !important; }" });
    await mcp.call("browser_scroll", {});
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const tip = await where(page);
    assert.ok(Math.abs(tip.x - size.w / 2) <= 2 && Math.abs(tip.y - size.h / 2) <= 2, JSON.stringify(tip));
    assert.notEqual(await region(page, Math.round(tip.x), Math.round(tip.y)), await region(page, BLANK.x, BLANK.y), "the arrow is on the screen");
  });
});

describe("with BROWSER_CURSOR=0", () => {
  let mcp;
  before(async () => {
    await closeTabs(1);
    mcp = await connectMcp({ BROWSER_CURSOR: "0" });
  });
  after(async () => {
    await mcp?.close();
    await closeObservers();
  });

  test("nothing is drawn and nothing is put into the page", async () => {
    const view = await mcp.call("browser_navigate", { url: fixture.url("/cursor/10") });
    const page = await tabAt(fixture.url("/cursor/10"));
    const middle = await page.evaluate(() => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }));
    const blank = await region(page, BLANK.x, BLANK.y);
    assert.equal(await region(page, middle.x, middle.y), blank, "blank before");
    await mcp.call("browser_click", { ref: refOf(view, /button "Press 10"/) });
    await mcp.call("browser_scroll", {});
    assert.equal(await region(page, middle.x, middle.y), blank, "blank after a click and a scroll, where the tip would be");
    assert.equal(await page.evaluate(() => typeof window.__agentCursor), "undefined");
    // No shadow root of ours on <body>: the page could attach its own.
    assert.equal(await page.evaluate(() => {
      try {
        document.body.attachShadow({ mode: "open" }).append(document.createElement("slot"));
        return "free";
      } catch {
        return "taken";
      }
    }), "free");
  });
});
