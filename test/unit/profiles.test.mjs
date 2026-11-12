import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { stopGuard } from "../../dist/navguard.js";
import { PROFILE_NAME, Profiles, clientLimit, loadProfiles, parseProfiles } from "../../dist/profiles.js";
import { SCHEMAS } from "../../dist/schema.js";
import { browserTools, disconnect, instructions } from "../../dist/tools.js";
import { validateArgs } from "../../dist/validate.js";
import { fakeBrowser } from "./fake-browser.mjs";

/**
 * Named browser profiles: the profiles.json parser, the name rule, the choice of a profile by a call's argument and the
 * client's limit; then two profiles served at once against fake browsers (one connection, followed tab, fence and set of
 * refs each).
 */

process.env.BROWSER_FRAMES = "0";
process.env.BROWSER_CURSOR = "0";
delete process.env.BROWSER_ALLOWED_HOSTS;

const file = (...profiles) => JSON.stringify({ profiles });
const entry = (name, cdpPort = 9322, hosts = []) => ({ name, cdpPort, hosts });

test("profiles.json: names, ports and hosts are read; a bad file is an error that says what is wrong with it", () => {
  const [a, b] = parseProfiles(file(entry("default", 9322, ["Docs.Example.com", "*.cdn.example.com"]), entry("work-2", 9323)));
  assert.deepEqual([a.name, a.cdp(), a.hosts()], ["default", "http://127.0.0.1:9322", ["docs.example.com", "*.cdn.example.com"]]);
  assert.deepEqual([b.name, b.cdp(), b.hosts()], ["work-2", "http://127.0.0.1:9323", []]);
  const bad = (text, pattern) => assert.throws(() => parseProfiles(text), pattern);
  bad("{", /^Error: it is not valid JSON$/);
  bad("{}", /^Error: it has no "profiles" list$/);
  bad(file(entry("Work")), /^Error: profile 1 has no valid name/);
  bad(file(entry("a b")), /^Error: profile 1 has no valid name/);
  bad(file(entry("default"), entry("default")), /^Error: profile "default" is listed twice$/);
  bad(file(entry("work", 0)), /^Error: profile "work" has no valid cdpPort$/);
  bad(file(entry("work", "9322")), /^Error: profile "work" has no valid cdpPort$/);
  bad(file(entry("work", 70000)), /^Error: profile "work" has no valid cdpPort$/);
  bad(file(entry("work", 9322, "a.test")), /^Error: profile "work": hosts must be a list of strings$/);
  bad(file(entry("work", 9322, [1])), /^Error: profile "work": hosts must be a list of strings$/);
});

test("a profiles.json that cannot be read is an error, not a fall-back; without one there is the default profile from the environment", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sbm-profiles-"));
  try {
    process.env.BROWSER_PROFILES_FILE = path.join(dir, "missing.json");
    process.env.BROWSER_CDP_URL = "http://127.0.0.1:9999/";
    process.env.BROWSER_ALLOWED_HOSTS = "a.test";
    const [only, ...more] = loadProfiles();
    assert.equal(more.length, 0);
    assert.deepEqual([only.name, only.cdp(), only.hosts()], ["default", "http://127.0.0.1:9999", ["a.test"]]);
    process.env.BROWSER_ALLOWED_HOSTS = "b.test";
    assert.deepEqual(only.hosts(), ["b.test"], "the environment is read at each use, as in 1.1.0");
    const broken = path.join(dir, "profiles.json");
    writeFileSync(broken, "{ not json");
    process.env.BROWSER_PROFILES_FILE = broken;
    assert.throws(() => loadProfiles(), (e) => e.message === `${broken}: it is not valid JSON`);
    writeFileSync(broken, file(entry("default", 9400), entry("work", 9401, ["x.test"])));
    assert.deepEqual(loadProfiles().map((p) => [p.name, p.cdp(), p.hosts()]), [["default", "http://127.0.0.1:9400", []], ["work", "http://127.0.0.1:9401", ["x.test"]]]);
  } finally {
    for (const v of ["BROWSER_PROFILES_FILE", "BROWSER_CDP_URL", "BROWSER_ALLOWED_HOSTS"]) delete process.env[v];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the name rule: lowercase letters, digits and -, starting with a letter, at most 24 characters", () => {
  for (const ok of ["default", "work", "a", "work-2", "a".repeat(24)]) assert.ok(PROFILE_NAME.test(ok), ok);
  for (const bad of ["Work", "a b", "../x", "", "a".repeat(25), "1work", "-work", "work_2", "work\n", "wörk", "work/x"]) assert.ok(!PROFILE_NAME.test(bad), JSON.stringify(bad));
});

const fake = (name, hosts = []) => ({ name, cdp: () => `http://127.0.0.1:1${name.length}`, hosts: () => hosts });
const trio = () => [fake("default"), fake("work"), fake("personal")];

test("a call picks its profile by name; no name is default; one error lists the names for an unknown or invalid one", () => {
  const profiles = new Profiles(trio());
  assert.equal(profiles.pick(undefined).name, "default");
  assert.equal(profiles.pick(null).name, "default");
  assert.equal(profiles.pick("work").name, "work");
  assert.throws(() => profiles.pick("nope"), (e) => e.message === 'There is no profile "nope". Profiles: default, work, personal.');
  for (const bad of ["Work", "../x", "", "a".repeat(25), 7, {}]) {
    assert.throws(() => profiles.pick(bad), /^Error: ".*" is not a valid profile name \(lowercase letters, digits and -, starting with a letter, at most 24 characters\)\. Profiles: default, work, personal\.$/s, JSON.stringify(bad));
  }
});

test("BROWSER_PROFILES limits a client: other profiles are refused, and a limit without default means a call must name one", () => {
  assert.equal(clientLimit(undefined), undefined);
  assert.equal(clientLimit("  "), undefined);
  assert.deepEqual(clientLimit("personal, work"), ["personal", "work"]);
  assert.throws(() => clientLimit("work,Bad"), /^Error: BROWSER_PROFILES: "Bad" is not a valid profile name$/);
  const profiles = new Profiles(trio(), ["personal"]);
  assert.deepEqual(profiles.names(), ["personal"]);
  assert.equal(profiles.pick("personal").name, "personal");
  assert.throws(() => profiles.pick("work"), (e) => e.message === 'Profile "work" is not available to this client (BROWSER_PROFILES). Profiles: personal.');
  assert.throws(() => profiles.pick(undefined), (e) => e.message === 'This client may not use the "default" profile (BROWSER_PROFILES), so a call must name one with profile: personal.');
  assert.throws(() => profiles.pick("nope"), /^Error: There is no profile "nope"\. Profiles: personal\.$/);
  assert.throws(() => new Profiles(trio(), ["ghost"]), /^Error: BROWSER_PROFILES names "ghost", which is not a profile \(profiles: default, work, personal\)$/);
});

// What every tool took in 1.1.0 (before `profile`): names and required lists are a public interface.
const TOOLS = {
  browser_navigate: [["url"], ["url"]],
  browser_back: [[], []],
  browser_snapshot: [["mode"], []],
  browser_click: [["ref", "double"], ["ref"]],
  browser_type: [["ref", "text", "submit"], ["ref", "text"]],
  browser_select: [["ref", "option"], ["ref", "option"]],
  browser_key: [["key"], ["key"]],
  browser_scroll: [["direction", "screens", "ref"], []],
  browser_find: [["query"], ["query"]],
  browser_get_text: [["ref", "offset", "max_chars"], ["ref"]],
  browser_screenshot: [["ref"], []],
  browser_upload: [["ref", "files"], ["ref", "files"]],
};

test("the same twelve tools; each has the optional profile argument and nothing else changed", () => {
  const defs = browserTools("t", new Profiles(trio()));
  assert.deepEqual(defs.map((d) => d.name), Object.keys(TOOLS));
  for (const d of defs) {
    const [props, required] = TOOLS[d.name];
    assert.deepEqual(Object.keys(d.inputSchema.properties), [...props, "profile"], d.name);
    assert.deepEqual(d.inputSchema.required ?? [], required, `${d.name}: profile is never required`);
    assert.equal(d.inputSchema.additionalProperties, false);
    const p = d.inputSchema.properties.profile;
    assert.deepEqual([p.type, p.default], ["string", "default"]);
    assert.match(p.description, /Profiles: default, work, personal\.$/);
    assert.equal(validateArgs(d.inputSchema, { ...Object.fromEntries(required.map((r) => [r, r === "files" ? ["/x"] : "x"])), profile: "work" }), null, d.name);
    assert.equal(validateArgs(d.inputSchema, { ...Object.fromEntries(required.map((r) => [r, r === "files" ? ["/x"] : "x"])), profile: 5 }), 'Argument "profile" must be a string.', d.name);
  }
  assert.equal(Object.keys(SCHEMAS).length, 12);
});

test("the instructions mention profiles only when there is more than one to choose from", () => {
  const defs = browserTools("t", new Profiles(trio()));
  assert.equal(instructions(defs), instructions(defs, ["default"]), "single-profile instructions are those of 1.1.0");
  assert.doesNotMatch(instructions(defs), /profile/i);
  const text = instructions(defs, ["default", "work"]);
  assert.match(text, /^Browser profiles keep separate signed-in sessions \(default, work\)\. Use a profile only when the user's task names it; otherwise leave out profile\. A ref belongs to the profile that showed it\.$/m);
  assert.match(instructions(defs, ["personal"]), /\(personal\)/);
});

// ---- Two profiles at once, against fake browsers ----------------------------------------------------------------------

/** One fake browser: a tab at `url` whose elements are `refs`; it notes its goto calls. */
function fakeProfileBrowser(label, refs) {
  const state = { url: `http://${label}.fixture.test/start`, gotos: [], connects: 0 };
  const locator = (ref) => ({ count: async () => (refs.includes(ref) ? 1 : 0), click: async () => {} });
  const page = {
    isClosed: () => false,
    context: () => context,
    url: () => state.url,
    ariaSnapshotJSON: async () => [],
    evaluate: async (fn) => (String(fn).includes("scrollHeight") ? { width: 800, height: 600, scrollY: 0, scrollHeight: 600 } : undefined),
    title: async () => `Page of ${label}`,
    locator: (selector) => locator(selector.replace("aria-ref=", "")),
    mouse: { move: async () => {}, wheel: async () => {} },
    goto: async (url) => void (state.gotos.push(url), (state.url = url.endsWith("/bounce") ? "http://blocked.example.net/secret" : url)),
    goBack: async () => null,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    bringToFront: async () => {},
    _channel: { updateSubscription: async () => {} },
    on() { return this; },
    off() { return this; },
  };
  const context = {
    pages: () => [page],
    on: () => {},
    off: () => {},
    newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: `tab-of-${label}` } }), detach: async () => {} }),
  };
  const browser = { isConnected: () => true, contexts: () => [context], on: () => {}, close: async () => {} };
  return { state, connect: async () => (state.connects++, browser) };
}

const browsers = new Map();
const refused = new Set();
chromium.connectOverCDP = async (url) => {
  if (refused.has(url)) throw new Error("browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1\nCall log: ...");
  const b = browsers.get(url);
  if (!b) throw new Error(`no fake browser at ${url}`);
  return b.connect();
};
afterEach(() => {
  browsers.clear();
  refused.clear();
});
after(async () => {
  stopGuard();
  await disconnect();
});

const profileAt = (name, port, hosts = []) => ({ name, cdp: () => `http://127.0.0.1:${port}`, hosts: () => hosts });
const toolsOf = (profiles, limit) => new Map(browserTools("unit-profiles", new Profiles(profiles, limit)).map((d) => [d.name, d]));
const call = (tools, name, args) => tools.get(name).execute("call", args);
const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("two profiles at once: each has its own connection and followed tab, and a call without profile is default", async () => {
  const d = fakeProfileBrowser("d", ["e1"]);
  const w = fakeProfileBrowser("w", ["e1", "e7"]);
  browsers.set("http://127.0.0.1:20001", d);
  browsers.set("http://127.0.0.1:20002", w);
  const tools = toolsOf([profileAt("default", 20001), profileAt("work", 20002)]);
  assert.match(textOf(await call(tools, "browser_snapshot", {})), /Page of d/);
  assert.match(textOf(await call(tools, "browser_snapshot", { profile: "default" })), /Page of d/);
  assert.equal(w.state.connects, 0, "a profile no call named is never connected");
  assert.match(textOf(await call(tools, "browser_snapshot", { profile: "work" })), /Page of w/);
  await call(tools, "browser_navigate", { url: "http://w.fixture.test/next", profile: "work" });
  assert.deepEqual(w.state.gotos, ["http://w.fixture.test/next"]);
  assert.deepEqual(d.state.gotos, [], "work's navigation left default's tab alone");
  assert.equal(d.state.url, "http://d.fixture.test/start");
  await call(tools, "browser_snapshot", {});
  assert.equal(d.state.connects, 1);
  assert.equal(w.state.connects, 1, "one connection per profile, kept");
});

test("a ref shown by one profile is not found in another: the normal 'points at nothing' error", async () => {
  browsers.set("http://127.0.0.1:20001", fakeProfileBrowser("d", ["e1"]));
  browsers.set("http://127.0.0.1:20002", fakeProfileBrowser("w", ["e1", "e7"]));
  const tools = toolsOf([profileAt("default", 20001), profileAt("work", 20002)]);
  await call(tools, "browser_click", { ref: "e7", profile: "work" });
  await assert.rejects(call(tools, "browser_click", { ref: "e7" }), /^Error: e7 points at nothing on the page now: /);
  await assert.rejects(call(tools, "browser_click", { ref: "e7", profile: "default" }), /^Error: e7 points at nothing on the page now: /);
});

test("an unknown, invalid or unavailable profile fails with one plain error before any browser work", async () => {
  const d = fakeProfileBrowser("d", []);
  const w = fakeProfileBrowser("w", []);
  browsers.set("http://127.0.0.1:20001", d);
  browsers.set("http://127.0.0.1:20002", w);
  const all = [profileAt("default", 20001), profileAt("work", 20002)];
  const tools = toolsOf(all);
  for (const name of Object.keys(TOOLS)) {
    await assert.rejects(call(tools, name, { profile: "nope", ref: "e1", url: "https://x.test", key: "a", query: "a", option: "a", text: "a", files: ["/x"] }), /^Error: There is no profile "nope"\. Profiles: default, work\.$/, name);
  }
  await assert.rejects(call(tools, "browser_snapshot", { profile: "../x" }), /^Error: "\.\.\/x" is not a valid profile name/);
  await assert.rejects(call(tools, "browser_snapshot", { profile: "Work" }), /^Error: "Work" is not a valid profile name/);
  const fenced = toolsOf(all, ["work"]);
  await assert.rejects(call(fenced, "browser_snapshot", { profile: "default" }), /^Error: Profile "default" is not available to this client \(BROWSER_PROFILES\)\. Profiles: work\.$/);
  await assert.rejects(call(fenced, "browser_navigate", { url: "http://d.fixture.test/" }), /^Error: This client may not use the "default" profile/);
  assert.equal(d.state.connects + w.state.connects, 0, "nothing was connected");
  assert.deepEqual([d.state.gotos, w.state.gotos], [[], []]);
  assert.match(textOf(await call(fenced, "browser_snapshot", { profile: "work" })), /Page of w/);
});

test("each profile has its own allowed hosts: the same address is refused in one and opened in the other", async () => {
  browsers.set("http://127.0.0.1:20001", fakeProfileBrowser("d", []));
  const w = fakeProfileBrowser("w", []);
  browsers.set("http://127.0.0.1:20002", w);
  const tools = toolsOf([profileAt("default", 20001), profileAt("work", 20002, ["only.fixture.test"])]);
  const address = "http://other.fixture.test/page";
  await call(tools, "browser_navigate", { url: address });
  await assert.rejects(call(tools, "browser_navigate", { url: address, profile: "work" }), /^Error: Blocked: other\.fixture\.test is not an allowed host \(BROWSER_ALLOWED_HOSTS: only\.fixture\.test\)/);
  assert.deepEqual(w.state.gotos, [], "work never went there");
});

test("a profile whose browser is down says which one; the default profile's message is that of 1.1.0", async () => {
  refused.add("http://127.0.0.1:20002");
  refused.add("http://127.0.0.1:20003");
  const tools = toolsOf([profileAt("default", 20003), profileAt("work", 20002)]);
  await assert.rejects(call(tools, "browser_snapshot", { profile: "work" }), /^Error: Could not connect to the browser of profile work at http:\/\/127\.0\.0\.1:20002 \(/);
  await assert.rejects(call(tools, "browser_snapshot", {}), /^Error: Could not connect to the browser at http:\/\/127\.0\.0\.1:20003 \(/);
});

test("an answer that says where the tab stays names a non-default profile, and only then", async () => {
  const live = await fakeBrowser("answer", { tabs: 1 });
  const url = process.env.BROWSER_CDP_URL;
  delete process.env.BROWSER_CDP_URL;
  try {
    for (const [name, tag] of [["work", " \\(profile work\\)"], ["default", ""]]) {
      browsers.set(url, fakeProfileBrowser("w", []));
      const tools = toolsOf([{ name, cdp: () => url, hosts: () => ["w.fixture.test"] }].concat(name === "work" ? [profileAt("default", 20001)] : []));
      await call(tools, "browser_snapshot", name === "work" ? { profile: "work" } : {});
      await assert.rejects(
        call(tools, "browser_navigate", { url: "http://w.fixture.test/bounce", ...(name === "work" ? { profile: "work" } : {}) }),
        new RegExp(`^Error: Blocked: blocked\\.example\\.net is not on the allowed hosts \\(BROWSER_ALLOWED_HOSTS\\), and http://w\\.fixture\\.test/bounce led there\\. You are still on w\\.fixture\\.test${tag}\\.$`),
      );
      stopGuard();
    }
  } finally {
    stopGuard();
    await live.close();
  }
});

test("a fence on a browser that cannot be reached fails closed, naming the profile", async () => {
  browsers.set("http://127.0.0.1:20002", fakeProfileBrowser("w", []));
  const tools = toolsOf([profileAt("work", 20002, ["only.fixture.test"])]);
  // No fake CDP endpoint answers at 20002: the guard cannot be set up, so nothing runs.
  await assert.rejects(call(tools, "browser_snapshot", { profile: "work" }), /^Error: The browser of profile work is not reachable at http:\/\/127\.0\.0\.1:20002 to apply BROWSER_ALLOWED_HOSTS /);
});

test("with a fence on a live browser, a profile's guard is its own: the other profile's browser is never asked to intercept", async () => {
  const guarded = await fakeBrowser("answer", { tabs: 1 });
  const guardedUrl = process.env.BROWSER_CDP_URL;
  delete process.env.BROWSER_CDP_URL;
  const quiet = await fakeBrowser("answer", { tabs: 1 });
  const quietUrl = process.env.BROWSER_CDP_URL;
  delete process.env.BROWSER_CDP_URL;
  try {
    browsers.set(guardedUrl, fakeProfileBrowser("g", []));
    browsers.set(quietUrl, fakeProfileBrowser("q", []));
    const at = (name, url, hosts) => ({ name, cdp: () => url, hosts: () => hosts });
    const tools = toolsOf([at("default", quietUrl, []), at("work", guardedUrl, ["g.fixture.test"])]);
    await call(tools, "browser_snapshot", {});
    assert.equal(quiet.connections(), 0, "no fence, no guard connection");
    await call(tools, "browser_snapshot", { profile: "work" });
    assert.equal(guarded.connections(), 1, "the fenced profile's browser has the guard");
    assert.equal(quiet.connections(), 0);
  } finally {
    stopGuard();
    await guarded.close();
    await quiet.close();
  }
});
