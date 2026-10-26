import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { openFolder } from "../server/reveal.mjs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

function launcher({ code = 0, error = null, acknowledge = true } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const call = { command, args, options, input: "" };
    calls.push(call);
    child.stdin.on("data", (data) => (call.input += data));
    child.kill = () => {};
    process.nextTick(() => {
      child.emit("spawn");
      if (error) child.emit("error", error);
      else {
        if (code) child.stderr.write("Windows refused the folder request");
        else if (acknowledge) child.stdout.write(JSON.stringify({ ok: true }));
        child.emit("close", code, null);
      }
    });
    return child;
  };
  return { spawn, calls };
}

test("Windows reveal uses shell folder opening and passes Unicode paths as data", async () => {
  const fake = launcher();
  const folder = "C:\\Projects\\é雪 & [release]\\owner's folder";
  await openFolder(folder, { platform: "win32", spawnProcess: fake.spawn });
  assert.match(fake.calls[0].command, /powershell\.exe$/i);
  assert(fake.calls[0].args.some((a) => a.endsWith("windows-open-folder.ps1")));
  assert(
    !fake.calls[0].args.some((a) => a.includes(folder)),
    "Folder paths must not be interpolated into a shell command",
  );
  assert.deepEqual(JSON.parse(fake.calls[0].input), { folder });
});

test("silent process completion is not treated as a Windows folder acknowledgement", async () => {
  const fake = launcher({ acknowledge: false });
  await assert.rejects(
    openFolder("C:\\Projects", { platform: "win32", spawnProcess: fake.spawn }),
    /did not acknowledge/,
  );
});

test(
  "real Windows helper rejects missing folders before attempting to open them",
  { skip: process.platform !== "win32" },
  async () => {
    await assert.rejects(
      openFolder(path.join(tmpdir(), "reclaim-missing-é雪-" + randomUUID())),
      /moved|accessible/,
    );
  },
);

test(
  "real Windows helper validates long paths without launching Explorer",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "reclaim-reveal-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const folder = path.join(
      root,
      ...Array(6).fill("long-folder-name-".repeat(2)),
    );
    await mkdir(folder, { recursive: true });
    assert(folder.length > 260);
    const result = await new Promise((resolve, reject) => {
      const child = execFile(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fileURLToPath(
            new URL("../server/windows-open-folder.ps1", import.meta.url),
          ),
          "-ValidateOnly",
        ],
        { windowsHide: true, encoding: "utf8", timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || error.message));
          else resolve(JSON.parse(stdout));
        },
      );
      child.stdin.end(JSON.stringify({ folder }) + "\n");
    });
    assert.deepEqual(result, { ok: true });
  },
);

test("a started helper that rejects the folder request reports failure", async () => {
  const fake = launcher({ code: 1 });
  await assert.rejects(
    openFolder("C:\\Projects", { platform: "win32", spawnProcess: fake.spawn }),
    /Windows refused/,
  );
});

test("launcher errors are returned instead of a success toast", async () => {
  const fake = launcher({ error: new Error("Launcher unavailable") });
  await assert.rejects(
    openFolder("C:\\Projects", { platform: "win32", spawnProcess: fake.spawn }),
    /Launcher unavailable/,
  );
});
