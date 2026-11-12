import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * install.sh's profile commands against a scratch install folder, with `docker` and `curl` replaced by shims that log
 * their arguments and succeed: no container is started or touched. What is checked is what the script decides (names,
 * ports, env files, profiles.json, the project name of each stack, what uninstall asks for), not Docker.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const INSTALL = path.join(ROOT, "install.sh");
let work;
let shims;
let log;

before(() => {
  work = mkdtempSync(path.join(tmpdir(), "sbm-installer-"));
  shims = path.join(work, "bin");
  mkdirSync(shims);
  log = path.join(work, "docker.log");
  // `ps --status running -q browser` answers a container id for a stack the test marked as running; everything else is silent.
  writeFileSync(path.join(shims, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${log}"\nprintf '%s | %s\\n' "$*" "$(env | grep '^BROWSER_' | sort | tr '\\n' ' ')" >>"${log}.env"\ncase "$*" in *"ps --status running"*) echo abc123 ;; esac\nexit 0\n`);
  writeFileSync(path.join(shims, "curl"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(shims, "docker"), 0o755);
  chmodSync(path.join(shims, "curl"), 0o755);
});
after(() => rmSync(work, { recursive: true, force: true }));

/** A fresh install folder: the default profile's env file, the compose file and policy.sh, nothing running. */
function scratch(name) {
  const dir = path.join(work, name);
  mkdirSync(path.join(dir, "docker"), { recursive: true });
  writeFileSync(path.join(dir, "docker", ".env"), "BROWSER_PASSWORD=defaultpassword\nBROWSER_ALLOWED_HOSTS=\n");
  writeFileSync(path.join(dir, "docker", "compose.yaml"), "name: sandboxed-browser-mcp\n");
  copyFileSync(path.join(ROOT, "docker", "policy.sh"), path.join(dir, "docker", "policy.sh"));
  writeFileSync(path.join(dir, "package.json"), '{"version":"0.0.0"}\n');
  return dir;
}

function run(dir, args, env = {}) {
  writeFileSync(log, "");
  writeFileSync(`${log}.env`, "");
  const clean = { PATH: `${shims}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: work, ...env };
  const r = spawnSync("bash", [INSTALL, ...args, "--dir", dir], { env: clean, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr, docker: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

const envOf = (dir, name) => Object.fromEntries(readFileSync(path.join(dir, "profiles", name, ".env"), "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
const profilesJson = (dir) => JSON.parse(readFileSync(path.join(dir, "profiles.json"), "utf8"));
const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
const firstFree = async (from, taken = []) => {
  for (let p = from; ; p++) if (!taken.includes(p) && !(await listening(p))) return p;
};

test("a bad profile name fails before any docker call and creates nothing", () => {
  const dir = scratch("names");
  for (const bad of ["Work", "a b", "../x", "default", "test", "a".repeat(25), "1work", "work_2", ""]) {
    const r = run(dir, ["profile", "add", ...(bad ? [bad] : [])]);
    assert.notEqual(r.status, 0, JSON.stringify(bad));
    assert.match(r.out, /^install\.sh: profile: /, JSON.stringify(bad));
    assert.deepEqual(r.docker, [], `no docker call for ${JSON.stringify(bad)}`);
    assert.ok(!existsSync(path.join(dir, "profiles")) && !existsSync(path.join(dir, "profiles.json")), `nothing created for ${JSON.stringify(bad)}`);
  }
  const reserved = run(dir, ["profile", "add", "default"]);
  assert.match(reserved.out, /profile: 'default' is a reserved name/);
  assert.match(run(dir, ["profile", "add", "test"]).out, /profile: 'test' is a reserved name/);
  assert.match(run(dir, ["profile", "add", "a".repeat(24).toUpperCase()]).out, /not a valid name/);
  assert.equal(run(dir, ["profile", "add", "a".repeat(24), "--hosts", "bad host name"]).status, 1, "a 24-character name passes the name check (then the hosts check fails)");
});

test("profile add: first free ports above the default's, a private env file of its own, its own project, and profiles.json", async () => {
  const dir = scratch("add");
  const web = await firstFree(3102);
  const cdp = await firstFree(9323);
  const stream = await firstFree(8083);
  const r = run(dir, ["profile", "add", "work", "--hosts", "Docs.Example.com,*.example.org"]);
  assert.equal(r.status, 0, r.out);
  const env = envOf(dir, "work");
  assert.deepEqual([env.BROWSER_WEB_PORT, env.BROWSER_CDP_PORT, env.BROWSER_STREAM_PORT], [String(web), String(cdp), String(stream)]);
  assert.equal(env.BROWSER_ALLOWED_HOSTS, "Docs.Example.com,*.example.org");
  assert.match(env.BROWSER_PASSWORD, /^[A-Za-z0-9]{32}$/);
  assert.notEqual(env.BROWSER_PASSWORD, "defaultpassword");
  assert.equal(statSync(path.join(dir, "profiles", "work", ".env")).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(dir, "profiles", "work")).mode & 0o777, 0o700);
  assert.ok(!r.out.includes(env.BROWSER_PASSWORD), "the password is never printed");
  assert.deepEqual(r.docker.filter((l) => l.includes(" up ")), [`compose -p sandboxed-browser-mcp-work --env-file ${dir}/profiles/work/.env -f ${dir}/docker/compose.yaml up -d --quiet-pull`]);
  assert.deepEqual(profilesJson(dir), { profiles: [{ name: "default", cdpPort: 9322, hosts: [] }, { name: "work", cdpPort: cdp, hosts: ["Docs.Example.com", "*.example.org"] }] });
  assert.ok(!JSON.stringify(profilesJson(dir)).includes(env.BROWSER_PASSWORD), "profiles.json holds no password");

  const again = run(dir, ["profile", "add", "work"]);
  assert.match(again.out, /profile work exists/);
  assert.deepEqual(again.docker.filter((l) => l.includes(" up ")), []);

  const second = run(dir, ["profile", "add", "personal"]);
  assert.equal(second.status, 0, second.out);
  const other = envOf(dir, "personal");
  assert.deepEqual([other.BROWSER_WEB_PORT, other.BROWSER_CDP_PORT, other.BROWSER_STREAM_PORT], [String(await firstFree(web + 1)), String(await firstFree(cdp + 1)), String(await firstFree(stream + 1))]);
  assert.notEqual(other.BROWSER_PASSWORD, env.BROWSER_PASSWORD);
  assert.equal(other.BROWSER_ALLOWED_HOSTS, "");
  assert.deepEqual(profilesJson(dir).profiles.map((p) => p.name), ["default", "personal", "work"]);
});

test("a port another profile has claimed is skipped even when it is stopped, and one something listens on too", async () => {
  const dir = scratch("ports");
  // The default claims its own ports in its env file too (what an install made with other ports has).
  writeFileSync(path.join(dir, "docker", ".env"), "BROWSER_PASSWORD=x\nBROWSER_ALLOWED_HOSTS=\nBROWSER_CDP_PORT=9323\n");
  const busy = net.createServer();
  const at = await firstFree(9324);
  await new Promise((resolve, reject) => busy.once("error", reject).listen(at, "127.0.0.1", resolve));
  try {
    const r = run(dir, ["profile", "add", "work"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(envOf(dir, "work").BROWSER_CDP_PORT, String(await firstFree(at + 1, [9323])), "9322 is the default's by default, 9323 is claimed in its env file, and the listening one is skipped");
    assert.notEqual(envOf(dir, "work").BROWSER_CDP_PORT, String(at));
  } finally {
    busy.close();
  }
});

test("hosts the browser's policy would refuse stop profile add before anything starts", () => {
  const dir = scratch("hosts");
  const r = run(dir, ["profile", "add", "work", "--hosts", "not a host"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /^install\.sh: --hosts: /);
  assert.deepEqual(r.docker.filter((l) => l.includes(" up ")), []);
  assert.ok(!existsSync(path.join(dir, "profiles")));
});

test("profile list shows every profile with its ports, hosts and state; the default is first, under the compose file's own project", async () => {
  const dir = scratch("list");
  run(dir, ["profile", "add", "work", "--hosts", "a.example.com"]);
  const r = run(dir, ["profile", "list"]);
  assert.equal(r.status, 0, r.out);
  const rows = r.out.trim().split("\n").map((l) => l.trim().split(/\s+/));
  assert.deepEqual(rows[0], ["PROFILE", "DESKTOP", "CDP", "STREAM", "STATE", "HOSTS"]);
  assert.deepEqual(rows[1], ["default", "3101", "9322", "8082", "running", "any"]);
  assert.deepEqual(rows[2].slice(0, 1).concat(rows[2].slice(4)), ["work", "running", "a.example.com"]);
  assert.ok(r.docker.some((l) => l === `compose --env-file ${dir}/docker/.env -f ${dir}/docker/compose.yaml ps --status running -q browser`), "default: no -p, so it keeps its project and volume");
  assert.ok(r.docker.some((l) => l.startsWith("compose -p sandboxed-browser-mcp-work --env-file ") && l.endsWith("ps --status running -q browser")));
});

test("COMPOSE_PROJECT_NAME is the base of every other profile's project name", () => {
  const dir = scratch("base");
  const r = run(dir, ["profile", "add", "work"], { COMPOSE_PROJECT_NAME: "sbm-dev" });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.docker.some((l) => l.startsWith("compose -p sbm-dev-work ")));
});

test("shell BROWSER_* variables do not reach another profile's stack, and do for the default one as with compose", () => {
  const dir = scratch("env");
  const r = run(dir, ["profile", "add", "work"], { BROWSER_CDP_PORT: "9999" });
  assert.equal(r.status, 0, r.out);
  assert.notEqual(envOf(dir, "work").BROWSER_CDP_PORT, "9999");
  assert.equal(profilesJson(dir).profiles[0].cdpPort, 9999, "the default's ports are what its stack really uses");
  const calls = readFileSync(`${log}.env`, "utf8").split("\n").filter((l) => l.includes("-p sandboxed-browser-mcp-work "));
  assert.ok(calls.length > 0);
  for (const l of calls) assert.doesNotMatch(l.split(" | ")[1], /BROWSER_CDP_PORT=9999/, "the work stack's compose call does not see the shell's setting");
});

test("profile remove stops only that stack: its volume stays unless --purge; default cannot be removed", () => {
  const dir = scratch("remove");
  run(dir, ["profile", "add", "work"]);
  run(dir, ["profile", "add", "personal"]);
  for (const bad of [["default"], ["nope"], ["../x"], [""]]) {
    const r = run(dir, ["profile", "remove", ...bad.filter(Boolean)]);
    assert.equal(r.status, 1, JSON.stringify(bad));
    if (bad[0] === "default") assert.match(r.out, /profile: default is the install's own browser; uninstall removes it/);
    assert.deepEqual(r.docker.filter((l) => / down( |$)/.test(l)), [], `no down for ${JSON.stringify(bad)}`);
  }
  const kept = run(dir, ["profile", "remove", "work"]);
  assert.equal(kept.status, 0, kept.out);
  assert.deepEqual(kept.docker.filter((l) => / down( |$)/.test(l)), [`compose -p sandboxed-browser-mcp-work --env-file ${dir}/profiles/work/.env -f ${dir}/docker/compose.yaml down`]);
  assert.ok(!existsSync(path.join(dir, "profiles", "work")) && existsSync(path.join(dir, "profiles", "personal", ".env")), "only work's files went");
  assert.deepEqual(profilesJson(dir).profiles.map((p) => p.name), ["default", "personal"]);
  const purged = run(dir, ["profile", "remove", "personal", "--purge"]);
  assert.deepEqual(purged.docker.filter((l) => / down( |$)/.test(l)), [`compose -p sandboxed-browser-mcp-personal --env-file ${dir}/profiles/personal/.env -f ${dir}/docker/compose.yaml down -v`]);
  assert.deepEqual(profilesJson(dir).profiles.map((p) => p.name), ["default"]);
});

test("uninstall --purge with more than one profile lists them and needs --yes; with one it needs nothing", () => {
  const dir = scratch("purge");
  run(dir, ["profile", "add", "work"]);
  const refused = run(dir, ["uninstall", "--purge"]);
  assert.equal(refused.status, 1);
  assert.match(refused.out, /would delete the sessions \(volumes\) of every profile: default work\. Run it again with --yes/);
  assert.deepEqual(refused.docker.filter((l) => / down( |$)/.test(l)), [], "nothing was stopped or deleted");
  assert.ok(existsSync(path.join(dir, "profiles", "work", ".env")));
  const plain = run(dir, ["uninstall"]);
  assert.equal(plain.status, 0, plain.out);
  assert.deepEqual(plain.docker.filter((l) => / down( |$)/.test(l)).map((l) => l.replaceAll(dir, "DIR")), [
    "compose --env-file DIR/docker/.env -f DIR/docker/compose.yaml down",
    "compose -p sandboxed-browser-mcp-work --env-file DIR/profiles/work/.env -f DIR/docker/compose.yaml down",
  ]);

  const again = scratch("purge2");
  run(again, ["profile", "add", "work"]);
  const confirmed = run(again, ["uninstall", "--purge", "--yes"]);
  assert.equal(confirmed.status, 0, confirmed.out);
  assert.deepEqual(confirmed.docker.filter((l) => / down( |$)/.test(l)).map((l) => l.replaceAll(again, "DIR")), [
    "compose --env-file DIR/docker/.env -f DIR/docker/compose.yaml down -v",
    "compose -p sandboxed-browser-mcp-work --env-file DIR/profiles/work/.env -f DIR/docker/compose.yaml down -v",
  ]);
  assert.ok(!existsSync(again));

  const single = scratch("purge3");
  const one = run(single, ["uninstall", "--purge"]);
  assert.equal(one.status, 0, one.out);
  assert.deepEqual(one.docker.filter((l) => / down( |$)/.test(l)).map((l) => l.replaceAll(single, "DIR")), ["compose --env-file DIR/docker/.env -f DIR/docker/compose.yaml down -v"]);
});
