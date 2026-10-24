import { createHash } from "node:crypto";
import { createServer } from "node:http";

/**
 * A fake browser. `mode`: "silent" never finishes the websocket handshake, "mute" opens it and answers nothing, "answer"
 * answers every call with {}. With "answer", `tabs` are attached when the guard asks for auto-attach; `failFetch` answers
 * Fetch.enable on a tab with an error (its message, if a string), after telling the tab was detached when `detachFirst`.
 */
export async function fakeBrowser(mode, { tabs = 0, failFetch = false, detachFirst = false } = {}) {
  const sockets = [];
  const frame = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
    return Buffer.concat([head, body]);
  };
  const attached = (socket, sessionId) => socket.write(frame({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { targetId: `target-${sessionId}`, type: "page" } } }));
  let connections = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Browser: "Fake/1", webSocketDebuggerUrl: "ws://inside.container:9222/devtools/browser/fake" }));
  });
  server.on("upgrade", (req, socket) => {
    connections++;
    sockets.push(socket);
    if (mode === "silent") return;
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (mode !== "answer") return;
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      // Client frames: masked text, short or 16-bit length (CDP calls here are small).
      while (buffered.length >= 6) {
        let length = buffered[1] & 0x7f;
        let at = 2;
        if (length === 126) [length, at] = [buffered.readUInt16BE(2), 4];
        if (buffered.length < at + 4 + length) return;
        const mask = buffered.subarray(at, at + 4);
        const body = Buffer.from(buffered.subarray(at + 4, at + 4 + length).map((b, i) => b ^ mask[i % 4]));
        const opcode = buffered[0] & 0x0f;
        buffered = buffered.subarray(at + 4 + length);
        // A close: answered with one, as a browser does, so the client's close handshake ends at once.
        if (opcode === 8) return void socket.end(Buffer.from([0x88, 0x00]));
        if (opcode !== 1) continue;
        const { id, method, sessionId } = JSON.parse(String(body));
        if (method === "Target.setAutoAttach" && !sessionId) for (let i = 0; i < tabs; i++) attached(socket, `tab${i}`);
        if (method === "Fetch.enable" && failFetch) {
          if (detachFirst) socket.write(frame({ method: "Target.detachedFromTarget", params: { sessionId } }));
          socket.write(frame({ id, error: { message: typeof failFetch === "string" ? failFetch : "Fetch.enable failed on a fixture tab" } }));
        } else socket.write(frame({ id, result: {} }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.BROWSER_CDP_URL = `http://127.0.0.1:${server.address().port}`;
  return {
    connections: () => connections,
    /** A new tab, attached on every open websocket. */
    attach: (sessionId) => sockets.forEach((s) => s.writable && attached(s, sessionId)),
    /** Drops the browser's side of every websocket, as a browser that restarted would. */
    drop: () => sockets.forEach((s) => s.destroy()),
    close: async () => {
      sockets.forEach((s) => s.destroy());
      await new Promise((r) => server.close(r));
    },
  };
}
