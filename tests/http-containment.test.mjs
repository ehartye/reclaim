import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once, EventEmitter } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { startService } from "../server/index.mjs";
import { requestUrl } from "../server/http-boundary.mjs";

async function fixture(t, { httpTimeouts, deferredProbe = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "reclaim-http-"));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createApp } from ${JSON.stringify(new URL("../server/app.mjs", import.meta.url).href)};
    import { containRequest } from ${JSON.stringify(new URL("../server/http-boundary.mjs", import.meta.url).href)};
    let releaseProbe;
    const app = await createApp({
      dataDir: process.env.HTTP_TEST_DATA,
      httpTimeouts: ${JSON.stringify(httpTimeouts)},
      ...(${JSON.stringify(deferredProbe)} ? { routineProbe: async () => {
        process.send({ event: "probe-entered" });
        await new Promise(resolve => { releaseProbe = resolve; });
        return { scopes: [{ routineId: "npm-cache", path: process.env.HTTP_TEST_DATA }], notices: [] };
      } } : {}),
    });
    const listener = app.server.listeners("request")[0];
    app.server.removeAllListeners("request");
    let disconnected = 0;
    app.server.on("request", containRequest(async (req, res) => {
      if (req.url === "/fixture/disconnect-before") {
        await new Promise(resolve => res.once("close", resolve));
        disconnected++;
        throw Error("private failure after client close");
      }
      if (req.url === "/fixture/disconnect-after") {
        res.writeHead(200); res.write("started");
        await new Promise(resolve => res.once("close", resolve));
        disconnected++;
        throw Error("private failure after headers");
      }
      if (req.url === "/fixture/sent-error") {
        res.writeHead(200); res.write("partial");
        await new Promise(resolve => setImmediate(resolve));
        throw Error("private failure after headers");
      }
      if (req.url === "/fixture/ended-error") {
        res.end("complete");
        await new Promise(resolve => setImmediate(resolve));
        throw Error("private failure after end");
      }
      listener(req, res);
    }));
    process.on("message", async message => {
      if (message === "release-probe") releaseProbe();
      else if (message === "poison") {
        app.state.settings.fixture = { toJSON() { throw Error("secret-token /private/personal-path"); } };
      } else if (message === "restore") delete app.state.settings.fixture;
      else if (message === "stop") { await app.close(); process.disconnect(); return; }
      process.send({ ack: message, disconnected });
    });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    process.send({ port: app.server.address().port, timeouts: {
      headersTimeout: app.server.headersTimeout,
      requestTimeout: app.server.requestTimeout,
      keepAliveTimeout: app.server.keepAliveTimeout,
      connectionsCheckingInterval: app.server.connectionsCheckingInterval,
      socketTimeout: app.server.timeout,
      maxHeaderSize: app.server.maxHeaderSize,
    } });
  `,
    ],
    {
      env: { ...process.env, HTTP_TEST_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exit = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 20000);
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.connected) child.send("stop");
    const forced = setTimeout(() => child.kill(), 3000);
    const [code] = await exit;
    clearTimeout(forced);
    await rm(dataDir, { recursive: true, force: true });
    assert.equal(code, 0, output);
    assert.equal(
      output,
      "",
      "No raw requests, tokens, paths or unhandled failures in logs",
    );
  });
  const [{ port, timeouts }] = await Promise.race([
    once(child, "message"),
    exit.then(() => {
      throw Error(output || "Child exited before ready");
    }),
  ]);
  assert.notEqual(port, 4318);
  const command = async (name) => {
    const response = once(child, "message");
    child.send(name);
    return (await response)[0];
  };
  const base = `http://127.0.0.1:${port}`;
  const state = async () => {
    const response = await fetch(base + "/api/state");
    assert.equal(response.status, 200);
    return response.json();
  };
  return { child, port, base, state, command, timeouts };
}

function raw(
  port,
  target,
  { method = "GET", headers = {}, body = "", incomplete = false, splitAt } = {},
) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    const chunks = [];
    socket.setTimeout(4000, () =>
      socket.destroy(Error("Raw HTTP fixture timed out")),
    );
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("connect", () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: ${headers.Host || `127.0.0.1:${port}`}\r\nConnection: close\r\n${Object.entries(
          headers,
        )
          .filter(([key]) => key !== "Host")
          .map(([key, value]) => `${key}: ${value}\r\n`)
          .join("")}\r\n`,
      );
      const bytes = Buffer.from(body);
      if (splitAt !== undefined) {
        socket.write(bytes.subarray(0, splitAt));
        setTimeout(() => socket.write(bytes.subarray(splitAt)), 10);
      } else socket.write(bytes);
      if (incomplete) socket.end();
    });
  });
}

function jsonResponse(response, status, code, context) {
  assert.match(response, new RegExp(`^HTTP/1\\.1 ${status} `));
  assert.match(response, /content-type: application\/json/i, context);
  // Node's chunked framing is immaterial to the bounded error payload assertion.
  assert.ok(response.length < 1600);
  assert.ok(response.includes(`"code":"${code}"`));
}

test("raw malformed targets are contained and native parser rejection preserves process survival", async (t) => {
  const f = await fixture(t);
  for (const target of [
    "http://[",
    "http://example.invalid/api/state",
    "//evil.invalid/api/state",
    "/\\evil.invalid/api/state",
    "/bad#fragment",
    "/%",
    "/%ZZ",
    "/%E0%A4%A",
    "/%C0%AF",
    "/%00",
    "/%7F",
  ]) {
    const response = await raw(f.port, target);
    jsonResponse(response, 400, "INVALID_TARGET", target);
    assert.equal(response.includes(target), false);
    await f.state();
  }
  jsonResponse(
    await raw(f.port, "/" + "a".repeat(9000)),
    414,
    "TARGET_TOO_LONG",
  );
  await f.state();
  const parserResponse = await raw(f.port, "/" + "a".repeat(40000));
  assert.ok(
    parserResponse === "" || /^HTTP\/1\.1 (400|431) /.test(parserResponse),
  );
  assert.ok(parserResponse.length < 1600);
  await f.state();
  for (const target of [
    "example.invalid:80",
    "/bad\u0000",
    "/bad\u007f",
    "/bad\n",
  ]) {
    const response = await raw(f.port, target);
    assert.ok(response === "" || /^HTTP\/1\.1 (400|431) /.test(response));
    await f.state();
  }
  assert.throws(() => requestUrl("example.invalid:80", f.base), {
    status: 400,
  });
  // These checks cover UTF-8 byte accounting independently of parser encoding.
  assert.throws(() => requestUrl("/" + "é".repeat(4096), f.base), {
    status: 414,
  });
  assert.equal(
    requestUrl("/api/state?q=%C3%A9", f.base).pathname,
    "/api/state",
  );
  assert.equal(requestUrl("/api/%73tate", f.base).pathname, "/api/%73tate");
  assert.equal(
    requestUrl("/api/state", "http://127.0.0.1:80").href,
    "http://127.0.0.1/api/state",
  );
  assert.equal((await fetch(f.base + "/api/routines")).status, 200);
});

test("auth controls, JSON shape, UTF-8 body limits and aborted bodies retain bounded refusals", async (t) => {
  const f = await fixture(t);
  const initial = await f.state();
  assert.match(
    await raw(f.port, "/api/state", { headers: { Host: "foreign.invalid" } }),
    /^HTTP\/1\.1 403 /,
  );
  assert.match(
    await raw(f.port, "/api/state", {
      headers: { Origin: "https://foreign.invalid" },
    }),
    /^HTTP\/1\.1 403 /,
  );
  const post = async (body, extra = {}, options = {}) =>
    raw(f.port, "/api/settings", {
      method: "POST",
      body,
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Reclaim-Token": initial.token,
        "Content-Length": Buffer.byteLength(body),
        ...extra,
      },
    });
  jsonResponse(
    await post("{}", { "X-Reclaim-Token": "missing" }),
    403,
    "INVALID_REQUEST",
  );
  jsonResponse(
    await post("{}", { "Content-Type": "text/plain" }),
    400,
    "INVALID_REQUEST",
  );
  for (const body of ["{", "null", "[]", "1"]) {
    const response = await post(body);
    jsonResponse(response, 400, "INVALID_REQUEST");
    assert.equal(response.includes(initial.token), false);
  }
  const split = '{"exclusions":["é"]}';
  assert.match(
    await post(split, {}, { splitAt: Buffer.from(split).indexOf(0xc3) + 1 }),
    /^HTTP\/1\.1 200 /,
  );
  assert.deepEqual((await f.state()).settings.exclusions, ["é"]);
  assert.match(await post("{}" + " ".repeat(127998)), /^HTTP\/1\.1 200 /);
  jsonResponse(await post("{}" + " ".repeat(127999)), 413, "BODY_TOO_LARGE");
  jsonResponse(
    await post(JSON.stringify({ ignored: "é".repeat(65000) })),
    413,
    "BODY_TOO_LARGE",
  );
  const invalidUtf8 = Buffer.from([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
  ]);
  jsonResponse(await post(invalidUtf8), 400, "INVALID_REQUEST");
  await post(
    '{"folderMinBytes":321}',
    { "Content-Length": 100 },
    { incomplete: true },
  );
  assert.notEqual((await f.state()).settings.folderMinBytes, 321);
});

test("serialization and failures around disconnected, sent and ended responses stay inside the child", async (t) => {
  const f = await fixture(t);
  await f.command("poison");
  const failed = await raw(f.port, "/api/state");
  jsonResponse(failed, 500, "INTERNAL_ERROR");
  assert.doesNotMatch(failed, /secret-token|personal-path|private/);
  await f.command("restore");
  await f.state();
  for (const route of ["before", "after"]) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: f.port, host: "127.0.0.1" });
      socket.on("error", reject);
      socket.on("close", resolve);
      socket.on("connect", () => {
        socket.write(
          `GET /fixture/disconnect-${route} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\n\r\n`,
        );
        if (route === "before") setTimeout(() => socket.destroy(), 25);
      });
      socket.on("data", () => socket.destroy());
    });
    await f.state();
  }
  assert.equal((await f.command("check")).disconnected, 2);
  const partial = await raw(f.port, "/fixture/sent-error");
  assert.match(partial, /^HTTP\/1\.1 200 /);
  assert.equal((partial.match(/HTTP\/1\.1/g) || []).length, 1);
  assert.doesNotMatch(partial, /private|INTERNAL_ERROR/);
  const ended = await raw(f.port, "/fixture/ended-error");
  assert.match(ended, /complete/);
  assert.doesNotMatch(ended, /private|INTERNAL_ERROR/);
  await f.state();
});

function stalledRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    let response = "",
      started;
    socket.setTimeout(2500, () =>
      socket.destroy(Error("Native receipt timeout did not fire")),
    );
    socket.on("connect", () => {
      started = performance.now();
      socket.write(request);
    });
    socket.on("data", (chunk) => (response += chunk));
    socket.on("error", (cause) => {
      if (cause.code !== "ECONNRESET") reject(cause);
    });
    socket.on("close", () =>
      resolve({ response, elapsed: performance.now() - started }),
    );
  });
}

test("production timeout values are explicit; native header and body receipt deadlines close stalled requests", async (t) => {
  const production = await fixture(t);
  assert.deepEqual(production.timeouts, {
    headersTimeout: 15000,
    requestTimeout: 30000,
    keepAliveTimeout: 5000,
    connectionsCheckingInterval: 1000,
    socketTimeout: 0,
    maxHeaderSize: 16384,
  });
  const f = await fixture(t, {
    httpTimeouts: {
      headersTimeout: 120,
      requestTimeout: 350,
      keepAliveTimeout: 100,
      connectionsCheckingInterval: 10,
    },
  });
  const header = await stalledRequest(
    f.port,
    `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nX-Incomplete:`,
  );
  assert.match(header.response, /^HTTP\/1\.1 408 /);
  assert.ok(header.response.length < 1600);
  assert.ok(
    header.elapsed >= 100 && header.elapsed < 2000,
    `header elapsed ${header.elapsed}`,
  );
  const initial = await f.state();
  const body = await stalledRequest(
    f.port,
    `POST /api/settings HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Type: application/json\r\nX-Reclaim-Token: ${initial.token}\r\nContent-Length: 100\r\n\r\n{"folderMinBytes":321}`,
  );
  assert.match(body.response, /^HTTP\/1\.1 408 /);
  assert.ok(body.response.length < 1600);
  assert.ok(
    body.elapsed >= 300 && body.elapsed < 2000,
    `body elapsed ${body.elapsed}`,
  );
  assert.notEqual((await f.state()).settings.folderMinBytes, 321);
});

test("a received deferred application operation completes beyond the receipt deadline", async (t) => {
  const f = await fixture(t, {
    deferredProbe: true,
    httpTimeouts: {
      headersTimeout: 100,
      requestTimeout: 180,
      keepAliveTimeout: 100,
      connectionsCheckingInterval: 10,
    },
  });
  const initial = await f.state();
  const entered = once(f.child, "message");
  let settled = false;
  const response = fetch(f.base + "/api/routines/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Reclaim-Token": initial.token,
    },
    body: JSON.stringify({ routineId: "npm-cache" }),
  }).then((value) => {
    settled = true;
    return value;
  });
  // Attach a rejection observer immediately so a failed assertion cannot leave an
  // unhandled client rejection while fixture cleanup closes the child.
  void response.catch(() => {});
  assert.equal((await entered)[0].event, "probe-entered");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(settled, false);
  assert.equal((await f.state()).cleanupBusy, true);
  await f.command("release-probe");
  const completed = await response;
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).routineId, "npm-cache");
  assert.equal((await f.state()).cleanupBusy, false);
});

test("failed synchronous and asynchronous listen attempts await initialized-resource cleanup", async () => {
  for (const synchronous of [false, true]) {
    const server = new EventEmitter();
    let closed = false,
      closeCalls = 0;
    server.listen = () => {
      const cause = Error("private-startup-token C:/private/path");
      if (synchronous) throw cause;
      queueMicrotask(() => server.emit("error", cause));
    };
    const keepAlive = setInterval(() => {}, 1000);
    const messages = [];
    try {
      await assert.rejects(
        startService({
          port: 0,
          logger: {
            log: (message) => messages.push(message),
            error: (message) => messages.push(message),
          },
          appFactory: async () => ({
            server,
            async close() {
              closeCalls++;
              await new Promise((resolve) => setTimeout(resolve, 20));
              clearInterval(keepAlive);
              closed = true;
            },
          }),
        }),
        { message: "Reclaim could not start." },
      );
      assert.equal(closed, true);
      assert.equal(closeCalls, 1);
      assert.equal(server.listenerCount("listening"), 0);
      assert.equal(server.listenerCount("error"), 0);
      assert.deepEqual(messages, []);
    } finally {
      clearInterval(keepAlive);
    }
  }
});

test("successful startup exposes the actual ephemeral loopback address and closes once", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "reclaim-http-ready-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const messages = [];
  const service = await startService({
    port: 0,
    dataDir: directory,
    logger: {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
  });
  t.after(() => service.close());
  const address = service.app.server.address();
  assert.equal(address.address, "127.0.0.1");
  assert.notEqual(address.port, 4318);
  assert.deepEqual(messages, [
    `Reclaim is ready at http://127.0.0.1:${address.port}`,
  ]);
  assert.equal(
    (await fetch(`http://127.0.0.1:${address.port}/api/state`)).status,
    200,
  );
  const first = service.close();
  assert.equal(first, service.close());
  await first;
  assert.equal(service.app.server.listening, false);
});

test("native entry point exits nonzero on occupied port, invalid port and invalid saved state with bounded logs", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "reclaim-http-start-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  assert.notEqual(occupied.address().port, 4318);
  for (const port of [String(occupied.address().port), "invalid-port", "0"]) {
    if (port === "0")
      await writeFile(
        path.join(directory, "state.json"),
        "private-token invalid saved JSON",
      );
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../server/index.mjs", import.meta.url))],
      {
        env: { ...process.env, PORT: port, RECLAIM_DATA_DIR: directory },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timeout = setTimeout(() => child.kill(), 4000);
    const [code, signal] = await once(child, "exit");
    clearTimeout(timeout);
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.equal(stderr.trim(), "Reclaim could not start.");
  }
});
