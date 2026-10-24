import path from "node:path";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Helpers for the integration tests: they need the test browser stack running (docker/compose.yaml with
 * docker/compose.test.yaml, project sandboxed-browser-mcp-test; see README "Tests").
 *
 * The browser reaches a fixture site by two fictional host names, allowed.fixture.test and blocked.fixture.test, which
 * the test override gives to a fixture container on the stack's network (a server on the host is not reachable from
 * containers behind a host firewall such as ufw's default).
 */

export const CONTAINER = process.env.TEST_BROWSER_CONTAINER || "sandboxed-browser-mcp-test-browser-1";
export const CDP = process.env.BROWSER_CDP_URL || "http://127.0.0.1:9422";
export const STREAM_PORT = process.env.BROWSER_STREAM_PORT || "8182";
export const SERVER = path.resolve(import.meta.dirname, "../../dist/server.js");

export const FIXTURE_PORT = process.env.FIXTURE_PORT || "3299";

/**
 * Waits until the test stack answers: Chromium on CDP (the relay accepts a connection before Chromium listens, and closes
 * it) and the fixture site. Every integration test imports this module, so none starts against a stack still coming up.
 */
async function stackReady(timeoutMs = Number(process.env.TEST_STACK_TIMEOUT_MS || 60_000)) {
  const deadline = Date.now() + timeoutMs;
  const answers = async (url, ok) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return response.ok && ok(await response.text());
    } catch {
      return false;
    }
  };
  for (;;) {
    const cdp = await answers(`${CDP}/json/version`, (body) => body.includes('"Browser"'));
    const site = await answers(`http://127.0.0.1:${FIXTURE_PORT}/__hits`, () => true);
    if (cdp && site) return;
    if (Date.now() > deadline) {
      throw new Error(`The test stack is not ready after ${timeoutMs} ms (CDP ${CDP}: ${cdp ? "up" : "down"}, fixture :${FIXTURE_PORT}: ${site ? "up" : "down"}). Start it with npm run stack:test:up.`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
await stackReady();

/** The fixture site (fixture-server.mjs, in the test stack): its URLs as the browser sees them, and what each host received. */
export const fixture = {
  url: (p = "/") => `http://allowed.fixture.test${p}`,
  blockedUrl: (p = "/secret") => `http://blocked.fixture.test${p}`,
  hits: async () => (await fetch(`http://127.0.0.1:${FIXTURE_PORT}/__hits`)).json(),
  reset: async () => (await fetch(`http://127.0.0.1:${FIXTURE_PORT}/__reset`)).text(),
};

/** An MCP client on a spawned server (the built dist/server.js) over stdio, with the given environment on top of the test stack's. */
export async function connectMcp(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: process.env.PATH, BROWSER_CDP_URL: CDP, BROWSER_STREAM_PORT: STREAM_PORT, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "sandboxed-browser-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  const stderr = [];
  transport.stderr?.on("data", (d) => stderr.push(String(d)));
  const text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return {
    client,
    stderr,
    tools: () => client.listTools().then((r) => r.tools),
    /** The answer's text; the whole result when `raw`. */
    async call(name, args = {}, raw = false) {
      const result = await client.callTool({ name, arguments: args }).catch((e) => {
        // A server that died says why on stderr.
        e.message += `\n--- server stderr ---\n${stderr.join("")}`;
        throw e;
      });
      return raw ? result : text(result);
    },
    text,
    close: () => client.close(),
  };
}

/** The pages the browser really has open, from its own debugging port (not from what a tool said). */
export async function tabs() {
  return (await (await fetch(`${CDP}/json/list`)).json()).filter((t) => t.type === "page");
}

export async function closeTabs(keep = 1) {
  const pages = await tabs();
  for (const tab of pages.slice(0, Math.max(0, pages.length - keep))) await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
}

export const refOf = (text, pattern) => {
  const line = text.split("\n").find((l) => pattern.test(l));
  if (!line) throw new Error(`no line matching ${pattern} in:\n${text}`);
  return line.match(/\[((?:f\d+)?e\d+)\]/)[1];
};

const observers = [];
/** A second CDP client on the browser, to look at pages as the tools leave them. Closed by closeObservers(). */
export async function observe() {
  const browser = await chromium.connectOverCDP(CDP);
  observers.push(browser);
  return browser;
}
/** Lets go of the observers (a disconnect: the browser and its tabs stay), so that the test process can end. */
export async function closeObservers() {
  await Promise.all(observers.splice(0).map((b) => b.close().catch(() => {})));
}

const ROOT = path.resolve(import.meta.dirname, "../..");
const PROJECT = process.env.TEST_STACK_PROJECT || "sandboxed-browser-mcp-test";

/** `docker compose` on the test stack, as package.json's stack:test:* scripts run it. */
export async function compose(...args) {
  const { execFile } = await import("node:child_process");
  const files = ["-p", PROJECT, "--env-file", "docker/.env.test", "-f", "docker/compose.yaml", "-f", "docker/compose.test.yaml"];
  return new Promise((resolve, reject) =>
    execFile("docker", ["compose", ...files, ...args], { cwd: ROOT }, (e, stdout, stderr) => (e ? reject(new Error(`docker compose ${args.join(" ")}: ${stderr}`)) : resolve(stdout))),
  );
}

/** Waits until the browser answers on CDP again (after its relay was stopped). */
export async function cdpUp(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const up = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (up) return;
    if (Date.now() > deadline) throw new Error(`CDP at ${CDP} is not back after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Whether the browser reaches the blocked host now: a throwaway tab opened on it, then closed. */
async function reachesBlocked() {
  const probe = `/secret?probe=${Date.now()}`;
  const tab = await (await fetch(`${CDP}/json/new?http://blocked.fixture.test${probe}`, { method: "PUT" })).json();
  await new Promise((r) => setTimeout(r, 1200));
  await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
  return (await fixture.hits()).blocked.includes(probe);
}

/**
 * Writes the browser's policy (docker/policy.sh, through the stack's policy service) for `hosts`, and waits until the
 * browser applies it (it reloads the file within seconds), as a throwaway tab on the blocked host shows.
 */
export async function setPolicy(hosts, timeoutMs = 45_000) {
  await compose("run", "--rm", "--no-deps", "-e", `BROWSER_ALLOWED_HOSTS=${hosts}`, "policy");
  const blocking = hosts !== "" && !hosts.split(",").some((h) => h.trim() === "blocked.fixture.test");
  const deadline = Date.now() + timeoutMs;
  while ((await reachesBlocked()) === blocking) {
    if (Date.now() > deadline) throw new Error(`the browser did not apply the policy "${hosts}" within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
