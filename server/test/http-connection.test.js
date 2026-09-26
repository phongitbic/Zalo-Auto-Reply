import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { HttpConnection } from "../src/http-connection.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rawServer = async (onRequest) => {
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => { });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(buffer.slice(0, end).match(/content-length:\s*(\d+)/i)?.[1] ?? 0);
      if (buffer.length < end + 4 + length) return;
      const request = buffer.slice(0, end + 4 + length);
      buffer = buffer.slice(end + 4 + length);
      onRequest(socket, request);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    sockets,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
};

test("reuses one socket for sequential keep-alive requests and sends body in one request", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ port: req.socket.remotePort, body, host: req.headers.host });
      res.end(`echo:${body}`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = new HttpConnection(`http://127.0.0.1:${server.address().port}`);
  try {
    for (let index = 0; index < 5; index += 1) {
      const response = await connection.request({ path: "/api/group/sendmsg?x=1", method: "POST", body: `n=${index}` });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.toString(), `echo:n=${index}`);
    }
    assert.equal(new Set(seen.map((item) => item.port)).size, 1);
    assert.equal(seen[0].host, `127.0.0.1:${server.address().port}`);
  } finally {
    connection.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("parses chunked bodies, trailers, repeated set-cookie and skips 100-continue", async () => {
  const server = await rawServer((socket) => {
    socket.write("HTTP/1.1 100 Continue\r\n\r\n");
    socket.write("HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nTransfer-Encoding: chunked\r\n\r\n");
    socket.write("4\r\n{\"a\"\r\n");
    setTimeout(() => socket.write("3;ext=1\r\n:1}\r\n0\r\nX-Trailer: y\r\n\r\n"), 10);
  });
  const connection = new HttpConnection(server.origin);
  try {
    const response = await connection.request({ path: "/", method: "POST", body: "x" });
    assert.equal(response.body.toString(), "{\"a\":1}");
    assert.deepEqual(response.headers["set-cookie"], ["a=1", "b=2"]);
    assert.equal(connection.connected, true);
  } finally {
    connection.destroy();
    await server.close();
  }
});

test("reads until close when the response has no length and reports the socket as gone", async () => {
  const server = await rawServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\n\r\nhello");
    setTimeout(() => socket.end(" world"), 10);
  });
  const connection = new HttpConnection(server.origin);
  let disconnected = 0;
  connection.on("disconnect", () => { disconnected += 1; });
  try {
    const response = await connection.request({ path: "/" });
    assert.equal(response.body.toString(), "hello world");
    assert.equal(response.connectionClose, true);
    await sleep(10);
    assert.equal(disconnected, 1);
    assert.equal(connection.connected, false);
  } finally {
    connection.destroy();
    await server.close();
  }
});

test("closes the socket after Connection: close", async () => {
  const server = await rawServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok");
  });
  const connection = new HttpConnection(server.origin);
  let disconnected = 0;
  connection.on("disconnect", () => { disconnected += 1; });
  try {
    const response = await connection.request({ path: "/" });
    assert.equal(response.connectionClose, true);
    await sleep(10);
    assert.equal(disconnected, 1);
  } finally {
    connection.destroy();
    await server.close();
  }
});

test("emits disconnect as soon as the server closes an idle socket", async () => {
  const server = await rawServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
  });
  const connection = new HttpConnection(server.origin);
  try {
    await connection.request({ path: "/" });
    const disconnected = new Promise((resolve) => connection.once("disconnect", resolve));
    const startedAt = performance.now();
    server.sockets[0].end();
    await disconnected;
    assert.ok(performance.now() - startedAt < 100);
  } finally {
    connection.destroy();
    await server.close();
  }
});

test("rejects a request when the socket dies mid-response and supports abort", async () => {
  const server = await rawServer((socket, request) => {
    if (request.startsWith("GET /die")) {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc");
      setTimeout(() => socket.destroy(), 5);
    }
  });
  const connection = new HttpConnection(server.origin);
  try {
    await assert.rejects(connection.request({ path: "/die" }), /Socket closed/);
    await assert.rejects(
      connection.request({ path: "/hang", signal: AbortSignal.timeout(30) }),
      (error) => error.name === "TimeoutError" || error.name === "AbortError"
    );
    assert.equal(connection.busy, false);
  } finally {
    connection.destroy();
    await server.close();
  }
});

test("enforces the body size limit", async () => {
  const server = await rawServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n" + "x".repeat(100));
  });
  const connection = new HttpConnection(server.origin);
  try {
    await assert.rejects(connection.request({ path: "/", maxBodyBytes: 10 }), /exceeds 10 bytes/);
  } finally {
    connection.destroy();
    await server.close();
  }
});

test("reports connection errors", async () => {
  const server = await rawServer(() => { });
  const origin = server.origin;
  await server.close();
  const connection = new HttpConnection(origin);
  let errors = 0;
  connection.on("connectionError", () => { errors += 1; });
  await assert.rejects(connection.request({ path: "/" }));
  assert.equal(errors, 1);
  assert.equal(connection.busy, false);
});
