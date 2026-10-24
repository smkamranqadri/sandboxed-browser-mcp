import { cdpUrl } from "./cdp.js";
import { urlRefusal } from "./guard.js";

/**
 * The host allowlist as the browser applies it: every document request (top-level navigations, frames, popups, and
 * each hop of their redirects) of every tab and out-of-process frame is checked, and one to a host outside the list is
 * failed before it is sent.
 *
 * It is its own CDP connection to the browser, not Playwright's: with Target.setAutoAttach (waitForDebuggerOnStart),
 * a new tab or out-of-process frame is held until its interception is on, so its first request cannot run ahead of the
 * guard; and only document requests are paused, so images, scripts and XHR do not go through Node.
 *
 * If its connection drops, or a target that is still there cannot be set up, it is set up again at once (and retried
 * until it holds), not only at the next tool call.
 *
 * A filter, not a wall: sub-resources, workers' own requests, other CDP clients and what the person does by hand are
 * not covered (see the README).
 */

/** A document request the guard refused. `mainFrame`: a tab's own navigation, not a frame inside it; `targetId`: that tab's. */
export interface Refusal {
  url: string;
  mainFrame: boolean;
  targetId?: string;
}

/** What the guard refused since the last take(). */
let refusals: Refusal[] = [];
export const takeRefusals = (): Refusal[] => refusals.splice(0);
export const clearRefusals = (): void => void (refusals = []);

/** A promise of `fn` kept while it holds or is pending, and dropped when it fails, so that the next call tries again. */
export function untilFailure<T>(fn: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | null = null;
  return () => {
    kept ??= fn().catch((e) => {
      kept = null;
      throw e;
    });
    return kept;
  };
}

interface Message {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
  sessionId?: string;
}

let socket: WebSocket | null = null;

/**
 * Connects, attaches to every target, and resolves once each existing tab is intercepted. Each step that waits on the
 * browser gives up after `timeoutMs`, so that a browser that never answers fails the set-up instead of holding it (and
 * every call waiting on it) for good.
 */
async function start(list: string[], timeoutMs: number): Promise<void> {
  const gen = generation;
  const version = (await (await fetch(`${cdpUrl()}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })).json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("the browser gave no debugging websocket");
  // The browser names its websocket by the address it was asked on inside the container; the path is what counts.
  const at = new URL(cdpUrl());
  const ws = new WebSocket(`${at.protocol === "https:" ? "wss" : "ws"}://${at.host}${new URL(version.webSocketDebuggerUrl).pathname}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the debugging websocket did not open within ${timeoutMs} ms`));
      ws.close();
    }, timeoutMs);
    ws.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
    ws.addEventListener("error", () => (clearTimeout(timer), reject(new Error("the debugging websocket did not open"))), { once: true });
  });

  let next = 0;
  const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`the browser did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve: (r) => (clearTimeout(timer), resolve(r)), reject: (e) => (clearTimeout(timer), reject(e)) });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  /** The target each of this connection's sessions is attached to. */
  const targets = new Map<string, { targetId: string; type: string }>();
  /** Set-ups of attached targets not finished yet: the guard is ready once those of the existing targets are. */
  const setting = new Set<Promise<void>>();
  /** The first set-up that failed on a target still there: the connection is dropped and set up again. */
  let broken: Error | undefined;

  const attached = (params: { sessionId: string; targetInfo: { targetId: string; type: string } }) => {
    const { sessionId, targetInfo } = params;
    targets.set(sessionId, { targetId: targetInfo.targetId, type: targetInfo.type });
    const framed = targetInfo.type === "page" || targetInfo.type === "iframe";
    const setup = (async () => {
      if (framed) {
        await send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] }, sessionId);
        // Its own out-of-process frames, held the same way until they are intercepted.
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      }
      // Every target this attaches to waits for it, workers too: each is let go once its interception is on.
      await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    })()
      .catch((e: Error) => {
        // The target went away while it was being set up: nothing is left to guard.
        if (!targets.has(sessionId) || /session with given id not found/i.test(e.message)) return;
        // It is still there, unintercepted or held paused: drop the connection, so the guard is set up again whole.
        broken ??= e;
        ws.close();
      })
      .finally(() => setting.delete(setup));
    setting.add(setup);
  };

  const paused = (params: { requestId: string; request: { url: string }; frameId: string }, sessionId: string) => {
    const why = urlRefusal(params.request.url, list);
    const target = targets.get(sessionId);
    if (why) refusals.push({ url: params.request.url, mainFrame: target?.type === "page" && params.frameId === target.targetId, targetId: target?.targetId });
    const done = why
      ? send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId)
      : send("Fetch.continueRequest", { requestId: params.requestId }, sessionId);
    void done.catch(() => {});
  };

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    } else if (message.method === "Target.attachedToTarget") attached(message.params);
    else if (message.method === "Target.detachedFromTarget") targets.delete(message.params.sessionId);
    else if (message.method === "Fetch.requestPaused" && message.sessionId) paused(message.params, message.sessionId);
  });
  ws.addEventListener("close", () => {
    // The browser stopped intercepting with it: it is set up again now, not at the next call, so that a page left
    // running between calls is not unguarded until then.
    if (socket === ws) {
      socket = null;
      guard = null;
      rearm(list, timeoutMs);
    }
    for (const waiting of pending.values()) waiting.reject(new Error("the debugging websocket closed"));
    pending.clear();
  });

  // Stopped while it connected: this connection is not the guard's, and never sets itself up again.
  if (gen !== generation) {
    ws.close();
    throw new Error("the guard was stopped while it was being set up");
  }
  socket = ws;
  try {
    // The tabs open now are attached (and answered as attachedToTarget) before this returns; new ones as they come.
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    while (setting.size) await Promise.all(setting);
    if (broken) throw broken;
  } catch (e) {
    ws.close();
    throw broken ?? e;
  }
}

let guard: (() => Promise<void>) | null = null;
let stopped = false;
/** Counts stops, so that a set-up begun before one does not take over after it. */
let generation = 0;
let rearming: NodeJS.Timeout | undefined;

/** Sets the guard up again after its connection dropped: soon, then every few seconds until it holds or the server stops. */
function rearm(list: string[], timeoutMs: number, delayMs = 1000): void {
  if (stopped || rearming) return;
  rearming = setTimeout(() => {
    rearming = undefined;
    if (!stopped) ensureGuard(list, timeoutMs).catch(() => rearm(list, timeoutMs, 5000));
  }, delayMs);
  rearming.unref();
}

/**
 * Resolves once every document request of the browser is checked against `list`; an empty list needs no guard. Fails
 * when the guard cannot be set up (or the browser does not answer within `timeoutMs`), so that nothing runs unguarded,
 * and tries again on the next call.
 */
export function ensureGuard(list: string[], timeoutMs = 10_000): Promise<void> {
  if (!list.length) return Promise.resolve();
  stopped = false;
  guard ??= untilFailure(() => start(list, timeoutMs));
  return guard();
}

/** Closes the guard's connection, as the server stops. The browser stops intercepting with it. */
export function stopGuard(): void {
  stopped = true;
  generation++;
  clearTimeout(rearming);
  rearming = undefined;
  guard = null;
  socket?.close();
  socket = null;
}
