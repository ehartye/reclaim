import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { requestUrl } from "../server/http-boundary.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "reclaim-http-"));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createApp } from ${JSON.stringify(new URL("../server/app.mjs", import.meta.url).href)};
    import { containRequest } from ${JSON.stringify(new URL("../server/http-boundary.mjs", import.meta.url).href)};
    const app = await createApp({ dataDir: process.env.HTTP_TEST_DATA });
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
      if (message === "poison") {
        app.state.settings.fixture = { toJSON() { throw Error("secret-token /private/personal-path"); } };
      } else if (message === "restore") delete app.state.settings.fixture;
      else if (message === "stop") { await app.close(); process.disconnect(); return; }
      process.send({ ack: message, disconnected });
    });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    process.send({ port: app.server.address().port });
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
  const [{ port }] = await Promise.race([
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
  return { child, port, base, state, command };
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
    '{"staleDays":321}',
    { "Content-Length": 100 },
    { incomplete: true },
  );
  assert.notEqual((await f.state()).settings.staleDays, 321);
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
