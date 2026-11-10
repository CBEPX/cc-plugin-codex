/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Connect through the native WebSocket client without implementing frame parsing. */
export async function connectCodexSharedServer({ serverSocket, timeoutMs = 15000, onNotification = null, deadlineMs = Infinity }) {
  if (Date.now() >= deadlineMs) throw new Error("Shared app-server deadline expired.");
  const remainingMs = () => Math.max(1, Math.min(timeoutMs, deadlineMs - Date.now()));
  if (typeof serverSocket !== "string" || !path.isAbsolute(serverSocket)) {
    throw new Error("The shared app-server socket path must be absolute.");
  }
  // shortcut: native continuation needs Node's WebSocket; older runtimes retain manual continuation.
  if (typeof globalThis.WebSocket !== "function") {
    throw Object.assign(new Error("Shared continuation requires native WebSocket support (Node 22 or later)."), { code: "SHARED_RUNTIME_UNAVAILABLE" });
  }
  const secret = `/${randomBytes(24).toString("hex")}`;
  const sockets = new Set();
  const pending = new Map();
  let closed = false;
  let accepted = false;
  let ws;
  let counter = 0;
  const bridge = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const close = (error = new Error("Shared app-server connection closed.")) => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    try { ws?.close(); } catch { /* The connection may not have opened. */ }
    for (const socket of sockets) socket.destroy();
    bridge.close();
  };
  bridge.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  bridge.on("upgrade", (req, client, head) => {
    if (accepted || req.url !== secret) { client.destroy(); return; }
    accepted = true;
    const upstream = net.createConnection(serverSocket);
    sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => close(new Error("Cannot connect to the selected shared app-server socket.")));
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
    upstream.on("connect", () => {
      const headers = req.rawHeaders.reduce((out, field, i, fields) => i % 2 ? out : out + `${field}: ${fields[i + 1]}\r\n`, "");
      upstream.write(`GET / HTTP/1.1\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", () => resolve(null));
  });
  const port = /** @type {net.AddressInfo} */ (bridge.address()).port;
  try {
    ws = new globalThis.WebSocket(`ws://127.0.0.1:${port}${secret}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(new Error("Shared app-server connection timed out.")); }, remainingMs());
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(null); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); close(); reject(new Error("Shared app-server WebSocket failed.")); }, { once: true });
    });
    bridge.close();
    ws.addEventListener("close", () => close());
    ws.addEventListener("error", () => close(new Error("Shared app-server WebSocket failed.")));
    ws.addEventListener("message", ({ data }) => {
      let event;
      try { event = JSON.parse(String(data)); } catch { close(new Error("Invalid shared app-server JSON.")); return; }
      if (event.id != null && !event.method) {
        const waiter = pending.get(event.id);
        pending.delete(event.id);
        if (event.error) waiter?.reject(Object.assign(new Error("Shared app-server RPC refused."), { rpcCode: event.error.code, rpcMessage: event.error.message }));
        else waiter?.resolve(event.result);
      } else if (typeof onNotification === "function") onNotification(event);
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      if (Date.now() >= deadlineMs) { reject(new Error("Shared app-server deadline expired.")); return; }
      if (closed) { reject(new Error("Shared app-server connection closed.")); return; }
      const id = ++counter;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Shared app-server ${method} timed out.`)); }, remainingMs());
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { ws.send(JSON.stringify({ id, method, params })); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
    await request("initialize", { clientInfo: { name: "cc-plugin-codex-shared", version: "1" }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: "initialized" }));
    return { request, close };
  } catch (error) { close(); throw error; }
}
