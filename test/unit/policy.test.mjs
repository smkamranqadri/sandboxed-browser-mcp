import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * docker/policy.sh, run with the host's sh: BROWSER_ALLOWED_HOSTS in, the Chromium policy file out. Under a umask of 077,
 * so that the file is readable by the browser only because the script makes it so.
 */

const SCRIPT = path.resolve(import.meta.dirname, "../../docker/policy.sh");

function run(hosts, dir = mkdtempSync(path.join(tmpdir(), "policy-"))) {
  const file = path.join(dir, "sandboxed-browser-mcp.json");
  // What the script left, read the same way whether it exited 0 or not.
  const written = () => ({ policy: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null, mode: existsSync(file) ? statSync(file).mode & 0o777 : null });
  try {
    const out = execFileSync("sh", ["-c", 'umask 077 && exec sh "$1"', "sh", SCRIPT], { env: { PATH: process.env.PATH, POLICY_DIR: dir, ...(hosts === undefined ? {} : { BROWSER_ALLOWED_HOSTS: hosts }) }, encoding: "utf8", stdio: "pipe" });
    return { code: 0, out, dir, ...written() };
  } catch (e) {
    return { code: e.status, out: String(e.stderr), dir, error: e.message, ...written() };
  } finally {
    if (!process.env.KEEP_POLICY_DIRS) setImmediate(() => rmSync(dir, { recursive: true, force: true }));
  }
}

test("hosts become an allowlist over a blocklist of everything: a host exactly, a wildcard as its domain", () => {
  const r = run(" Docs.Example.com. , *.example.org,allowed.fixture.test");
  assert.equal(r.code, 0, r.error);
  assert.deepEqual(r.policy, { URLBlocklist: ["*"], URLAllowlist: ["about:blank", ".docs.example.com", "example.org", ".allowed.fixture.test"] });
  assert.equal(r.mode, 0o644, "readable by the browser's own user");
});

test("an empty or unset list, or a lone *, writes no policy, and takes away one written before", () => {
  // "*." is "*" once its trailing dot goes, as the server reads it too (guard.ts parseAllowlist).
  for (const hosts of [undefined, "", " , ", "*", "*.", "a.example.com,*"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "policy-"));
    writeFileSync(path.join(dir, "sandboxed-browser-mcp.json"), '{"URLBlocklist":["*"]}');
    const r = run(hosts, dir);
    assert.equal(r.code, 0, String(hosts));
    assert.equal(r.policy, null, `no policy for ${JSON.stringify(hosts)}`);
  }
});

test("an entry that is not a host name blocks everything and fails, rather than opening the browser", () => {
  for (const bad of ["example.com/path", "example.com:8080", "https://example.com", "exa mple.com", "a..b", ".example.com", 'x","*', "*.*.example.com"]) {
    const r = run(`allowed.test,${bad}`);
    assert.equal(r.code, 1, bad);
    assert.deepEqual(r.policy, { URLBlocklist: ["*"], URLAllowlist: ["about:blank"] }, bad);
    assert.equal(r.mode, 0o644, `the allow-nothing policy is readable by the browser too: ${bad}`);
    assert.match(r.out, /is not a host name; wrote a policy that allows nothing/, bad);
  }
});
