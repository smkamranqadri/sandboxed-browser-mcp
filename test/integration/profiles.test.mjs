import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CDP, closeTabs, connectMcp, fixture, tabs } from "./helpers.mjs";

/**
 * Two profiles at once, each a whole browser stack: the test stack (profile "default", CDP 9422) and a second one
 * (profile "other", CDP 9423; `npm run stack:test-b:up`, env in docker/.env.test-b, see docs/testing.md), found through a
 * profiles.json. They share nothing: not cookies, not tabs, not refs, not fences.
 */

const OTHER_CDP = process.env.TEST_OTHER_CDP || "http://127.0.0.1:9423";
const OTHER_FIXTURE_PORT = process.env.TEST_OTHER_FIXTURE_PORT || "3298";
const otherTabs = async () => (await (await fetch(`${OTHER_CDP}/json/list`)).json()).filter((t) => t.type === "page");
const otherHits = async () => (await fetch(`http://127.0.0.1:${OTHER_FIXTURE_PORT}/__hits`)).json();
const closeOtherTabs = async (keep = 1) => {
  const pages = await otherTabs();
  for (const tab of pages.slice(0, Math.max(0, pages.length - keep))) await fetch(`${OTHER_CDP}/json/close/${tab.id}`).catch(() => {});
};

let dir;
let file;
let mcp;
before(async () => {
  const up = await fetch(`${OTHER_CDP}/json/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  assert.ok(up, `the second test stack is not up at ${OTHER_CDP}: npm run stack:test-b:up`);
  dir = mkdtempSync(path.join(tmpdir(), "sbm-int-profiles-"));
  file = path.join(dir, "profiles.json");
  const cdpPort = (url) => Number(new URL(url).port);
  writeFileSync(
    file,
    JSON.stringify({ profiles: [{ name: "default", cdpPort: cdpPort(CDP), hosts: [] }, { name: "other", cdpPort: cdpPort(OTHER_CDP), hosts: ["allowed.fixture.test"] }] }),
  );
  await closeTabs(1);
  await closeOtherTabs(1);
  mcp = await connectMcp({ BROWSER_PROFILES_FILE: file });
  // A cookie left by an earlier run.
  for (const profile of ["default", "other"]) await mcp.call("browser_navigate", { url: fixture.url("/cookie/clear"), profile });
});
after(async () => {
  await mcp?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  // Nothing to tidy when the first stack or the second one never came up.
  await closeTabs(1).catch(() => {});
  await closeOtherTabs(1).catch(() => {});
});

test("the server lists the same twelve tools, each with the optional profile argument", async () => {
  const list = await mcp.tools();
  assert.equal(list.length, 12);
  for (const t of list) {
    assert.ok(!(t.inputSchema.required ?? []).includes("profile"), t.name);
    assert.deepEqual([t.inputSchema.properties.profile.type, t.inputSchema.properties.profile.default], ["string", "default"], t.name);
    assert.match(t.inputSchema.properties.profile.description, /Profiles: default, other\.$/, t.name);
  }
});

test("a cookie set in one profile is absent in the other, and each keeps its own", async () => {
  assert.match(await mcp.call("browser_navigate", { url: fixture.url("/cookie/show") }), /Cookie seen by the server: none/);
  assert.match(await mcp.call("browser_navigate", { url: fixture.url("/cookie/show"), profile: "other" }), /Cookie seen by the server: none/);
  await mcp.call("browser_navigate", { url: fixture.url("/cookie/set?v=alpha") });
  assert.match(await mcp.call("browser_navigate", { url: fixture.url("/cookie/show"), profile: "other" }), /Cookie seen by the server: none/, "not in the other profile");
  await mcp.call("browser_navigate", { url: fixture.url("/cookie/set?v=beta"), profile: "other" });
  assert.match(await mcp.call("browser_navigate", { url: fixture.url("/cookie/show") }), /Cookie seen by the server: seed=alpha\b/);
  assert.match(await mcp.call("browser_navigate", { url: fixture.url("/cookie/show"), profile: "default" }), /Cookie seen by the server: seed=alpha\b/);
  assert.match(await mcp.call("browser_navigate", { url: fixture.url("/cookie/show"), profile: "other" }), /Cookie seen by the server: seed=beta\b/);
  for (const profile of ["default", "other"]) await mcp.call("browser_navigate", { url: fixture.url("/cookie/clear"), profile });
});

test("each profile follows its own tab, in its own browser", async () => {
  await mcp.call("browser_navigate", { url: fixture.url("/form") });
  await mcp.call("browser_navigate", { url: fixture.url("/next"), profile: "other" });
  assert.match(await mcp.call("browser_snapshot", {}), /Page: .*[Ff]orm|form/i);
  const first = await tabs();
  const second = await otherTabs();
  assert.deepEqual(first.map((t) => t.url), [fixture.url("/form")]);
  assert.deepEqual(second.map((t) => t.url), [fixture.url("/next")]);
  await mcp.call("browser_navigate", { url: fixture.url("/long"), profile: "other" });
  assert.deepEqual((await tabs()).map((t) => t.url), [fixture.url("/form")], "the other profile's navigation left this browser alone");
  assert.deepEqual((await otherTabs()).map((t) => t.url), [fixture.url("/long")]);
});

test("a ref works only in the profile it came from, even when the other profile holds the same ref on its own page", async () => {
  const refs = (view) => [...view.matchAll(/\[((?:f\d+)?e\d+)(@[a-z-]+)?\]/g)].map((m) => m[1] + (m[2] ?? ""));
  // A ref names the document (f<n>), and each browser counts its own documents. Load the same page in both until the
  // counts agree, so that both profiles show exactly the same refs.
  const document = (view) => Number(refs(view)[0].match(/^f(\d+)/)[1]);
  let mine = await mcp.call("browser_navigate", { url: fixture.url("/form") });
  let theirs = await mcp.call("browser_navigate", { url: fixture.url("/form"), profile: "other" });
  for (let i = 0; i < 40 && document(mine) !== document(theirs); i++) {
    if (document(mine) < document(theirs)) mine = await mcp.call("browser_navigate", { url: fixture.url(`/form?again=${i}`) });
    else theirs = await mcp.call("browser_navigate", { url: fixture.url(`/form?again=${i}`), profile: "other" });
  }
  const first = refs(mine);
  const second = refs(theirs);
  assert.ok(first.length > 2 && !first.some((r) => r.includes("@")), `the default profile's refs have no tag: ${first}`);
  assert.ok(second.every((r) => r.endsWith("@other")), `the other profile's refs carry its name: ${second}`);
  assert.deepEqual(second.map((r) => r.replace("@other", "")), first, "the two pages hold the same refs: only the tag tells them apart");
  const last = first.at(-1);
  // The default profile's ref, used in the other profile: refused by the tag, not acted on although the same ref names an element there.
  const bare = await mcp.call("browser_click", { ref: last, profile: "other" }, true);
  assert.equal(bare.isError, true);
  assert.match(mcp.text(bare), new RegExp(`^${last} has no profile tag, so it is a ref of the default profile, and this call is for profile other: `));
  const crossed = await mcp.call("browser_click", { ref: `${last}@other` }, true);
  assert.equal(crossed.isError, true);
  assert.match(mcp.text(crossed), new RegExp(`^${last}@other is a ref of profile other, and this call is for profile default: `));
  assert.equal((await tabs()).length, 1);
  assert.equal((await otherTabs()).length, 1);
  for (const [ref, profile] of [[last, "default"], [`${last}@other`, "other"]]) {
    const own = await mcp.call("browser_get_text", { ref, profile }, true);
    assert.ok(!own.isError, `${ref} works in its own profile: ${mcp.text(own).slice(0, 200)}`);
  }
});

test("each fence holds on its own list: the same address is refused in one profile and opened in the other", async () => {
  await fixture.reset();
  await fetch(`http://127.0.0.1:${OTHER_FIXTURE_PORT}/__reset`);
  const refused = await mcp.call("browser_navigate", { url: fixture.blockedUrl(), profile: "other" }, true);
  assert.equal(refused.isError, true);
  assert.match(mcp.text(refused), /^Blocked: blocked\.fixture\.test is not an allowed host \(BROWSER_ALLOWED_HOSTS: allowed\.fixture\.test\)/);
  assert.deepEqual((await otherHits()).blocked, [], "the blocked host received nothing from the fenced profile");
  assert.ok(!(await otherTabs()).some((t) => /blocked\.fixture\.test/.test(t.url)));
  const opened = await mcp.call("browser_navigate", { url: fixture.blockedUrl() });
  assert.match(opened, /BLOCKED SHOP REACHED/, "the profile with no list goes there");
  await mcp.call("browser_navigate", { url: fixture.url("/") });
});

test("a redirect to a blocked host is put back in the fenced profile, and its answer names the profile", async () => {
  const result = await mcp.call("browser_navigate", { url: fixture.url("/bounce"), profile: "other" }, true);
  assert.equal(result.isError, true);
  assert.match(mcp.text(result), /^Blocked: blocked\.fixture\.test is not on the allowed hosts \(BROWSER_ALLOWED_HOSTS\), and http:\/\/allowed\.fixture\.test\/bounce led there\. You are still on [^ ]+ \(profile other\)\.$/);
});

test("a call without profile is a call for default", async () => {
  await mcp.call("browser_navigate", { url: fixture.url("/next") });
  assert.equal(await mcp.call("browser_snapshot", {}), await mcp.call("browser_snapshot", { profile: "default" }));
});

test("an unknown or invalid profile fails at once and touches no browser", async () => {
  const before = [(await tabs()).map((t) => t.url), (await otherTabs()).map((t) => t.url)];
  for (const [profile, pattern] of [
    ["nope", /^There is no profile "nope"\. Profiles: default, other\.$/],
    ["Work", /^"Work" is not a valid profile name/],
    ["../x", /^"\.\.\/x" is not a valid profile name/],
  ]) {
    const result = await mcp.call("browser_navigate", { url: fixture.url("/next"), profile }, true);
    assert.equal(result.isError, true, profile);
    assert.match(mcp.text(result), pattern);
  }
  assert.deepEqual([(await tabs()).map((t) => t.url), (await otherTabs()).map((t) => t.url)], before);
});

test("a client limited with BROWSER_PROFILES uses only those profiles", async () => {
  const limited = await connectMcp({ BROWSER_PROFILES_FILE: file, BROWSER_PROFILES: "other" });
  try {
    assert.match(limited.client.getInstructions(), /Browser profiles keep separate signed-in sessions \(other\)\./);
    const before = (await tabs()).map((t) => t.url);
    const refused = await limited.call("browser_navigate", { url: fixture.url("/secret"), profile: "default" }, true);
    assert.equal(refused.isError, true);
    assert.match(limited.text(refused), /^Profile "default" is not available to this client \(BROWSER_PROFILES\)\. Profiles: other\.$/);
    const omitted = await limited.call("browser_snapshot", {}, true);
    assert.match(limited.text(omitted), /^This client may not use the "default" profile/);
    assert.deepEqual((await tabs()).map((t) => t.url), before, "the default browser was not touched");
    assert.match(await limited.call("browser_snapshot", { profile: "other" }), /Page:/);
  } finally {
    await limited.close();
  }
});
