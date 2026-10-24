#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cdpUrl } from "./cdp.js";
import { allowlist, wrapUntrusted } from "./guard.js";
import { browserTools, disconnect, instructions, runCall, ToolError, type ToolDef } from "./tools.js";
import { validateArgs } from "./validate.js";

/**
 * The browser tools as a stdio MCP server. One server process is one session: one tab, followed from call to call, and the
 * calls run one at a time in the order they came, each starting only when the one before it has been answered.
 *
 * stdout is the protocol; everything this prints goes to stderr.
 */

const defs: ToolDef[] = browserTools(`mcp-${process.pid}`);
const byName = new Map(defs.map((d) => [d.name, d]));

/** This release, as package.json (one directory above dist/) says. */
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const server = new Server(
  { name: "sandboxed-browser-mcp", version },
  { capabilities: { tools: {} }, instructions: instructions(defs) },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: defs.map((d) => ({
    name: d.name,
    title: d.label,
    description: d.description,
    inputSchema: d.inputSchema as { type: "object"; properties?: Record<string, unknown>; required?: string[] },
    annotations: { title: d.label, readOnlyHint: Boolean(d.readOnly), openWorldHint: true },
  })),
}));

/** The calls in line: each starts when the one before it is over, however that went. */
let line: Promise<unknown> = Promise.resolve();
const inOrder = <T>(job: () => Promise<T>): Promise<T> => {
  const run = line.then(job, job);
  line = run.catch(() => {});
  return run;
};

const failed = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/**
 * How long one call may take before it is answered as failed, so that a page that never answers (a script in an endless
 * loop) holds up only that call, not every call queued after it. Longer than any wait of a tool's own. The late call is
 * abandoned then: it stops at its next step rather than running on alongside the next call.
 */
const CALL_TIMEOUT_MS = Number(process.env.BROWSER_CALL_TIMEOUT_MS) || 90_000;

function inTime<T>(name: string, work: Promise<T>, abandon: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandon();
      reject(new ToolError(`${name} did not finish within ${Math.round(CALL_TIMEOUT_MS / 1000)} s: the page is not responding. Try browser_navigate to another address, or tell the user.`));
    }, CALL_TIMEOUT_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function call(def: ToolDef, args: unknown): Promise<CallToolResult> {
  const bad = validateArgs(def.inputSchema, args);
  if (bad) return failed(bad);
  try {
    const { result: work, abandon } = runCall(() => def.execute("call", args ?? {}));
    const result = await inTime(def.name, work, abandon);
    // Text read from a page is data from outside: wrapped, and flagged when it carries an injection signal.
    return { content: result.content.map((c) => (c.type === "text" ? { type: "text" as const, text: wrapUntrusted(c.text) } : c)) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Our own refusals as they are; the browser's words (Playwright's errors can quote the page) as outside content.
    return failed(e instanceof ToolError ? message : wrapUntrusted(message.slice(0, 1500)));
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const def = byName.get(request.params.name);
  if (!def) return failed(`Unknown tool "${request.params.name}".`);
  return inOrder(() => call(def, request.params.arguments));
});

// A stray rejection from the browser connection (a page closed mid-call) must not end the session: say so on stderr and go on.
process.on("uncaughtException", (e) => console.error(`sandboxed-browser-mcp: uncaught: ${e instanceof Error ? e.stack : e}`));
process.on("unhandledRejection", (e) => console.error(`sandboxed-browser-mcp: unhandled rejection: ${e instanceof Error ? e.stack : e}`));

let stopping = false;
async function stop(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.race([disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  process.exit(code);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.stdin.on("end", () => void stop());
process.stdin.on("close", () => void stop());

await server.connect(new StdioServerTransport());
const hosts = allowlist();
console.error(`sandboxed-browser-mcp: ${defs.length} tools; browser at ${cdpUrl()}; ${hosts.length ? `allowed hosts: ${hosts.join(", ")}` : "any host allowed"}`);
