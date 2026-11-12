import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The built server (dist/server.js) started with a profiles.json: what it lists, what it says, and when it refuses to start. No browser. */

const SERVER = path.resolve(import.meta.dirname, "../../dist/server.js");
const dir = mkdtempSync(path.join(tmpdir(), "sbm-server-profiles-"));
const good = path.join(dir, "profiles.json");
writeFileSync(good, JSON.stringify({ profiles: [{ name: "default", cdpPort: 9, hosts: [] }, { name: "work", cdpPort: 10, hosts: ["docs.example.com"] }, { name: "personal", cdpPort: 11, hosts: [] }] }));
const broken = path.join(dir, "broken.json");
writeFileSync(broken, '{"profiles":[{"name":"Work","cdpPort":9,"hosts":[]}]}');

after(() => rmSync(dir, { recursive: true, force: true }));
const env = (extra) => ({ PATH: process.env.PATH, ...extra });

test("the server refuses to start on a profiles.json it cannot read, or a BROWSER_PROFILES that names no profile", () => {
  for (const [extra, pattern] of [
    [{ BROWSER_PROFILES_FILE: broken }, /^sandboxed-browser-mcp: .*broken\.json: profile 1 has no valid name/],
    [{ BROWSER_PROFILES_FILE: path.join(dir, "profiles.json"), BROWSER_PROFILES: "ghost" }, /^sandboxed-browser-mcp: BROWSER_PROFILES names "ghost", which is not a profile \(profiles: default, work, personal\)\n$/],
    [{ BROWSER_PROFILES_FILE: good, BROWSER_PROFILES: "Work" }, /^sandboxed-browser-mcp: BROWSER_PROFILES: "Work" is not a valid profile name\n$/],
  ]) {
    const r = spawnSync(process.execPath, [SERVER], { env: env(extra), input: "", encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 1, JSON.stringify(extra));
    assert.match(r.stderr, pattern);
    assert.equal(r.stdout, "", "nothing on the protocol stream");
  }
});

test("a client limited to one profile lists only that profile, and is told about it; stderr names each profile's browser and hosts", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: env({ BROWSER_PROFILES_FILE: good, BROWSER_PROFILES: "work,personal" }), stderr: "pipe" });
  const stderr = [];
  const client = new Client({ name: "unit", version: "0.0.0" });
  await client.connect(transport);
  transport.stderr?.on("data", (d) => stderr.push(String(d)));
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
    for (const t of tools) assert.match(t.inputSchema.properties.profile.description, /Profiles: work, personal\.$/, t.name);
    assert.match(client.getInstructions(), /Browser profiles keep separate signed-in sessions \(work, personal\)\./);
    const refused = await client.callTool({ name: "browser_snapshot", arguments: { profile: "default" } });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, 'Profile "default" is not available to this client (BROWSER_PROFILES). Profiles: work, personal.');
    const omitted = await client.callTool({ name: "browser_snapshot", arguments: {} });
    assert.match(omitted.content[0].text, /^This client may not use the "default" profile/);
    const unknown = await client.callTool({ name: "browser_snapshot", arguments: { profile: "nope" } });
    assert.equal(unknown.content[0].text, 'There is no profile "nope". Profiles: work, personal.');
    await new Promise((r) => setTimeout(r, 200));
    const text = stderr.join("");
    assert.match(text, /profile default \(not for this client\): browser at http:\/\/127\.0\.0\.1:9; any host allowed/);
    assert.match(text, /profile work: browser at http:\/\/127\.0\.0\.1:10; allowed hosts: docs\.example\.com/);
  } finally {
    await client.close();
  }
});

test("without a profiles.json the server has one profile, default, and its instructions do not mention profiles", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: env({ BROWSER_PROFILES_FILE: path.join(dir, "none.json"), BROWSER_CDP_URL: "http://127.0.0.1:9" }), stderr: "pipe" });
  const client = new Client({ name: "unit", version: "0.0.0" });
  await client.connect(transport);
  try {
    assert.doesNotMatch(client.getInstructions(), /profile/i);
    const { tools } = await client.listTools();
    assert.match(tools[0].inputSchema.properties.profile.description, /Profiles: default\.$/);
  } finally {
    await client.close();
  }
});

test("a client entry whose BROWSER_ALLOWED_HOSTS differs from the default profile's hosts in profiles.json is refused at start (the fence does not fail open)", () => {
  const strict = path.join(dir, "strict.json");
  writeFileSync(strict, JSON.stringify({ profiles: [{ name: "default", cdpPort: 9, hosts: ["docs.example.com"] }, { name: "work", cdpPort: 10, hosts: [] }] }));
  const start = (file, hosts) => spawnSync(process.execPath, [SERVER], { env: env({ BROWSER_PROFILES_FILE: file, ...(hosts === undefined ? {} : { BROWSER_ALLOWED_HOSTS: hosts }) }), input: "", encoding: "utf8", timeout: 10_000 });
  // 1.1.0 put the hosts on the client entry; after an update docker/.env (so profiles.json) may hold none.
  const open = start(good, "docs.example.com");
  assert.equal(open.status, 1, open.stderr);
  assert.match(open.stderr, /^sandboxed-browser-mcp: BROWSER_ALLOWED_HOSTS on this client entry \(docs\.example\.com\) differs from the default profile's hosts in profiles\.json \(any host\)\. The server will not start/);
  assert.equal(open.stdout, "");
  const other = start(strict, "*.other.example.com");
  assert.equal(other.status, 1, other.stderr);
  assert.match(other.stderr, /\(\*\.other\.example\.com\) differs from the default profile's hosts in profiles\.json \(docs\.example\.com\)/);
  for (const [file, hosts, why] of [[strict, "Docs.Example.com", "the same list, in other case"], [strict, undefined, "no entry list"], [strict, "", "an empty entry list"], [good, undefined, "any host on both sides"]]) {
    const r = start(file, hosts);
    assert.equal(r.status, 0, `${why}: ${r.stderr}`);
  }
});

test("profiles.json is found when the install folder has a space and a non-ASCII letter in its name", () => {
  const install = path.join(dir, "my installs ü", "sbm");
  mkdirSync(path.join(install, "dist"), { recursive: true });
  cpSync(path.resolve(import.meta.dirname, "../../dist"), path.join(install, "dist"), { recursive: true });
  cpSync(path.resolve(import.meta.dirname, "../../package.json"), path.join(install, "package.json"));
  symlinkSync(path.resolve(import.meta.dirname, "../../node_modules"), path.join(install, "node_modules"));
  const copy = path.join(install, "dist", "server.js");
  const start = () => spawnSync(process.execPath, [copy], { env: env({}), input: "", encoding: "utf8", timeout: 10_000 });
  // A broken file is an error only if the server found it; a server that did not would fall back to the environment's one profile.
  writeFileSync(path.join(install, "profiles.json"), '{"profiles":[{"name":"Work","cdpPort":9,"hosts":[]}]}');
  const broken = start();
  assert.equal(broken.status, 1, broken.stderr);
  assert.ok(broken.stderr.includes(`${path.join(install, "profiles.json")}: profile 1 has no valid name`), broken.stderr);
  writeFileSync(path.join(install, "profiles.json"), JSON.stringify({ profiles: [{ name: "default", cdpPort: 9, hosts: ["docs.example.com"] }, { name: "work", cdpPort: 10, hosts: [] }] }));
  const good2 = start();
  assert.equal(good2.status, 0, good2.stderr);
  assert.match(good2.stderr, /profile work: browser at http:\/\/127\.0\.0\.1:10; any host allowed/);
  assert.match(good2.stderr, /profile default: browser at http:\/\/127\.0\.0\.1:9; allowed hosts: docs\.example\.com/);
});
