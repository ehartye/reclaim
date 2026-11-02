// Green assertions mean the evidence harness worked, not a qualified cleanup lane.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir, release, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { checkManifest } from "./fixtures/cleanup-identity/check-manifest.mjs";

const execute = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
// The negative case is last; no successor mutator starts after invalidation.
const cases = ["ordinary", "target-rename", "ancestor-rename", "changed-descendant", "late-created-descendant", "hardlink", "alternate-stream", "conflicting-handle", "cancel", "helper-failure", "unicode", "job-collision", "blocked-cancel"];
async function observe(file) {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink());
    const bytes = await fs.readFile(file);
    return { exists: true, dev: String(stat.dev), ino: String(stat.ino), bytes: bytes.length, sha256: digest(bytes) };
  } catch (error) { if (error.code !== "ENOENT") throw error; return { exists: false }; }
}
async function readOptional(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}
async function inventory(dir, prefix = "") {
  const artifacts = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) artifacts.push(...await inventory(path.join(dir, entry.name), relative + "/"));
    else if (relative !== "evidence-inventory.json") {
      const bytes = await fs.readFile(path.join(dir, entry.name));
      artifacts.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  return artifacts;
}

test("native cleanup evidence preserves failures, strict drain and Invalidated watchdog verdict", { skip: process.platform !== "win32" ? "Windows-only experiment; other lanes unsupported" : false, timeout: 180000 }, async (t) => {
  const manifest = await checkManifest(), runId = randomUUID();
  const output = path.join(repo, "review", "cleanup-identity", `native-${runId}`);
  await fs.mkdir(output, { recursive: true });
  const helper = path.join(output, "cleanup-identity.exe"), results = [], sources = [];
  let verdict = "Partial", stopReason = null, failure = null, helperIdentity = null, host = null;
  try {
    for (const relative of ["tests/fixtures/cleanup-identity/native-prototype.cs", "tests/fixtures/cleanup-identity/build-native.ps1", "tests/cleanup-identity-qualification.test.mjs", "tests/fixtures/cleanup-identity/manifest.json"]) {
      const bytes = await fs.readFile(path.join(repo, relative));
      sources.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
      const copy = path.join(output, "source", relative); await fs.mkdir(path.dirname(copy), { recursive: true }); await fs.writeFile(copy, bytes);
    }
    const build = await execute("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "tests/fixtures/cleanup-identity/build-native.ps1"), "-OutputDirectory", output], { windowsHide: true, timeout: 30000 });
    await fs.writeFile(path.join(output, "build.txt"), build.stdout + build.stderr);
    const bytes = await fs.readFile(helper); helperIdentity = { bytes: bytes.length, sha256: digest(bytes) };
    const git = (await execute("git", ["--version"], { windowsHide: true, timeout: 10000 })).stdout.trim();
    let windows;
    try { windows = JSON.parse((await execute("powershell.exe", ["-NoProfile", "-Command", "$r = Get-ItemProperty 'HKLM:/SOFTWARE/Microsoft/Windows NT/CurrentVersion'; @{BuildNumber=$r.CurrentBuildNumber;UBR=$r.UBR;BuildLabEx=$r.BuildLabEx} | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 15000 })).stdout); }
    catch { windows = { unavailable: "Bounded 15-second registry read did not establish metadata" }; }
    host = { platform: process.platform, osRelease: release(), architecture: arch(), node: process.version, git, windows, dotNetOsVersionCaution: "Environment.OSVersion can be compatibility-virtualized; use host.osRelease and registry build" };

    for (const name of cases) {
      const fixture = await fs.mkdtemp(path.join(tmpdir(), "reclaim-cleanup-native-" + (name === "unicode" ? "résumé-日本語-" : "")));
      const owned = await fs.lstat(fixture, { bigint: true }), canonical = await fs.realpath(fixture), temporary = await fs.realpath(tmpdir());
      assert(canonical.startsWith(`${temporary}${path.sep}`));
      let drained = false, nativeReceiptPresent = false;
      const folder = path.join(fixture, "project", "dist"), payload = path.join(folder, "payload"), sentinel = path.join(fixture, "outside-preview", "sentinel");
      const caseOutput = path.join(output, name); await fs.mkdir(caseOutput);
      try {
        await fs.mkdir(folder, { recursive: true }); await fs.mkdir(path.dirname(sentinel));
        await fs.writeFile(path.join(fixture, "fixture.marker"), runId);
        await fs.writeFile(payload, name === "unicode" ? "synthetic résumé 日本語" : "synthetic generated output");
        await fs.writeFile(sentinel, "unselected fixture bytes");
        if (name === "hardlink") { await fs.unlink(payload); await fs.link(sentinel, payload); }
        if (name === "alternate-stream") await fs.writeFile(`${payload}:fixture-note`, "synthetic alternate stream");
        const before = { payload: await observe(payload), sentinel: await observe(sentinel) };
        await fs.writeFile(path.join(fixture, "expected.json"), JSON.stringify({ ino: before.payload.ino }));
        // Never kill the mutative supervisor on a JS deadline. Nonzero exits are
        // data: read its native receipt and observe files before asserting.
        const processResult = await execute(helper, [name === "job-collision" ? "collision" : "supervisor", fixture, name], { windowsHide: true, maxBuffer: 128000 })
          .then((r) => ({ exitCode: 0, stdout: r.stdout, stderr: r.stderr }))
          .catch((e) => ({ exitCode: e.code ?? null, stdout: e.stdout ?? "", stderr: e.stderr ?? "", error: e.message }));
        await fs.writeFile(path.join(caseOutput, "process-result.json"), JSON.stringify(processResult, null, 2));
        await fs.mkdir(path.join(caseOutput, "native"));
        for (const entry of await fs.readdir(fixture, { withFileTypes: true })) if (entry.isFile()) await fs.copyFile(path.join(fixture, entry.name), path.join(caseOutput, "native", entry.name));
        const supervisor = await readOptional(path.join(fixture, "supervisor.json"));
        const finalDrain = await readOptional(path.join(fixture, "supervisor-finally-drain.json"));
        const collisionDrain = await readOptional(path.join(fixture, "collision-drain.json"));
        nativeReceiptPresent = supervisor !== null;
        // Even an unexpected failure can leave a durable positive drain proof.
        // This permits safe fixture teardown, never a successful operation claim.
        drained = (supervisor?.primaryExited === true && supervisor?.jobActive === 0)
          || (typeof processResult.exitCode === "number" && finalDrain?.originalWorkerExited === true && finalDrain?.jobActive === 0)
          || (name === "job-collision" && typeof processResult.exitCode === "number" && collisionDrain?.originalMemberExited === true && collisionDrain?.jobActive === 0);
        const worker = await readOptional(path.join(fixture, "worker.json")), actor = await readOptional(path.join(fixture, "actor.json"));
        const after = { payload: await observe(payload), sentinel: await observe(sentinel), late: await observe(path.join(folder, "late")) };
        if (supervisor?.strategyVerdict === "Invalidated" || supervisor?.watchdogMissed === true) { verdict = "Invalidated"; stopReason = "Five-second drain deadline missed; operation interrupted; candidate stopped"; }
        const outsideUnchanged = JSON.stringify(after.sentinel) === JSON.stringify(before.sentinel);
        if (!outsideUnchanged) { verdict = "Invalidated"; stopReason = "Outside-preview observation changed; candidate stopped"; }
        const row = { case: name, status: supervisor?.watchdogMissed ? "interrupted" : name === "job-collision" ? "refused" : worker?.status ?? "unknown", strategyVerdict: supervisor?.strategyVerdict ?? "Partial", outsideUnchanged, strictDrainObserved: drained, processExitCode: processResult.exitCode, fileSystem: supervisor?.fileSystem ?? null, volumeSerial: supervisor?.volumeSerial ?? null };
        results.push(row);
        await fs.writeFile(path.join(caseOutput, "receipt.json"), JSON.stringify({ ...row, fixture, before, after, worker, actor, supervisor, finalDrain, collisionDrain, processResult }, null, 2));
        assert(nativeReceiptPresent, "Missing native receipt; no success/drain inferred");
        assert(drained, "Original process exit and zero active Job members both required");
        assert(outsideUnchanged, `Outside sentinel changed: ${name}`);
        if (name === "blocked-cancel") {
          assert.equal(processResult.exitCode, 2); assert.equal(supervisor.strategyVerdict, "Invalidated"); assert.equal(supervisor.watchdogMissed, true);
          assert.equal(supervisor.operationReceipt.status, "interrupted"); assert.equal(supervisor.operationReceipt.deletedFiles, null); assert.deepEqual(after.payload, before.payload);
          const stopped = supervisor.trace.find((e) => e.event === "stop-requested"), missed = supervisor.trace.find((e) => e.event === "drain-watchdog-missed");
          assert.equal(stopped.reason, "explicit-cancel");
          const elapsed = Number(BigInt(missed.qpc) - BigInt(stopped.qpc)) * 1000 / Number(supervisor.qpcFrequency);
          assert(elapsed >= 5000 && elapsed < 10000, `First-cancel watchdog elapsed ${elapsed}ms`);
          assert(await readOptional(path.join(fixture, "supervisor-pending.json")), "Invalidation durable before termination/drain");
        } else if (name === "job-collision") {
          assert.equal(processResult.exitCode, 0); assert.equal(supervisor.collisionRefused, true); assert.equal(supervisor.existingContainerUnchanged, true); assert.equal(supervisor.originalMemberAliveAfterRefusal, true);
          assert.equal(supervisor.delayedMemberExited, true); assert.equal(supervisor.collisionTransientObserved, true); assert.equal(supervisor.watchdogMissed, false);
          const firstStop = supervisor.trace.filter((event) => event.event === "collision-stop-requested");
          assert.equal(firstStop.length, 1, "Original exit must not reset the first-stop deadline");
          const transient = supervisor.trace.find((event) => event.event === "collision-original-exited-with-members"), terminal = supervisor.trace.find((event) => event.event === "collision-strict-drain");
          assert(transient && transient.originalMemberExited && !transient.delayedMemberExited && transient.jobActive > 0, "Controlled delayed member must survive original member exit");
          assert(BigInt(terminal.qpc) > BigInt(transient.qpc));
          const drainMs = Number(BigInt(terminal.qpc) - BigInt(supervisor.stopRequestedQpc)) * 1000 / Number(supervisor.qpcFrequency);
          const afterOriginalMs = Number(BigInt(terminal.qpc) - BigInt(transient.qpc)) * 1000 / Number(supervisor.qpcFrequency);
          assert(drainMs < 5000 && afterOriginalMs >= 200, `One first-stop drain ${drainMs}ms; controlled post-original drain ${afterOriginalMs}ms`);
          const refusal = await readOptional(path.join(fixture, "collision-refusal.json"));
          assert.equal(refusal.nativeError, 183); assert.equal(refusal.containerOwned, false); assert.equal(refusal.workerSpawned, false); assert.deepEqual(after.payload, before.payload);
        } else {
          assert.equal(processResult.exitCode, 0); assert.equal(supervisor.watchdogMissed, false); assert.equal(supervisor.fileSystem, "NTFS");
          if (["hardlink", "alternate-stream", "conflicting-handle"].includes(name)) { assert.equal(worker.status, "refused"); assert.equal(worker.deletedFiles, 0); assert.deepEqual(after.payload, before.payload); }
          else if (["cancel", "helper-failure"].includes(name)) { assert.equal(worker.status, "interrupted"); assert.equal(worker.deletedFiles, 0); assert.deepEqual(after.payload, before.payload); }
          else if (name === "late-created-descendant") { assert.equal(worker.status, "partial"); assert.equal(worker.deletedFiles, 1); assert.equal(after.late.exists, true); assert.match(worker.reason, /145/); }
          else { assert.equal(worker.status, "complete"); assert.equal(worker.deletedFiles, 1); assert.equal(after.payload.exists, false); }
          if (["target-rename", "ancestor-rename", "changed-descendant"].includes(name)) { assert.equal(actor.success, false); assert([5, 32].includes(actor.nativeError)); }
        }
        t.diagnostic(`${name}: operation=${row.status}; strategy=${row.strategyVerdict}; outside unchanged; strict drain observed`);
      } finally {
        if (drained) {
          const current = await fs.lstat(fixture, { bigint: true });
          assert(!current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino); assert.equal(await fs.realpath(fixture), canonical);
          assert(path.basename(fixture).startsWith("reclaim-cleanup-native-") && canonical.startsWith(`${temporary}${path.sep}`));
          await fs.rm(fixture, { recursive: true, force: true });
          await fs.writeFile(path.join(caseOutput, "teardown.json"), JSON.stringify({ fixture, strictDrainObserved: true, removed: true }));
        } else {
          await fs.writeFile(path.join(caseOutput, "retained-fixture.json"), JSON.stringify({ fixture, nativeReceiptPresent, strictDrainObserved: false, reason: "Original process exit and zero members not both established; authority unknown; retain supervision and fixture; no successor mutator" }, null, 2));
        }
      }
      if (verdict === "Invalidated") break;
    }
    assert.equal(verdict, "Invalidated", "Blocked-cancellation negative fixture must invalidate candidate");
    assert.equal(results.at(-1).case, "blocked-cancel", "No successor after invalidation");
  } catch (error) { failure = { message: error.message, stack: error.stack }; throw error; }
  finally {
    const observations = { "target-rename-and-reparse-replacement": ["target-rename", "Retained target rename measured; see receipt; other boundaries unresolved"], "ancestor-rename-and-reparse-replacement": ["ancestor-rename", "Retained project rename measured; see receipt; other boundaries unresolved"], hardlink: ["hardlink", "One two-link leaf measured; see receipt"], "alternate-data-stream": ["alternate-stream", "One named stream measured; see receipt"], "changed-descendant": ["changed-descendant", "External write-open measured; see receipt"], "late-created-descendant": ["late-created-descendant", "Late child and selected-leaf outcomes measured; see receipt"], "external-conflicting-handle": ["conflicting-handle", "Existing writer measured; see receipt"], cancel: ["cancel", "Cooperative case measured; blocked case included only if present in cases"], "helper-failure": ["helper-failure", "Worker exit before disposition measured; see receipt"], "unicode-and-long-path": ["unicode", "Unicode names/content measured; long paths unresolved"], "drain-watchdog": ["blocked-cancel", "Blocked cancellation measured; strategy and operation dimensions recorded separately in receipt"] };
    const ran = new Set(results.map((row) => row.case));
    const matrix = manifest.requiredCases.filter((name) => !name.startsWith("git-")).map((name) => ({ case: name, verdict: ["cancel", "drain-watchdog"].includes(name) && ran.has("blocked-cancel") && verdict === "Invalidated" ? "Invalidated" : "Partial", evidence: observations[name] && ran.has(observations[name][0]) ? observations[name][1] : "Unresolved; not exercised in this run", nextExperiment: "Do not promote invalidated candidate; settle bounded admitted-operation drain/fencing before more qualification" }));
    await fs.writeFile(path.join(output, "generated-qualification.json"), JSON.stringify({ schema: "reclaim.cleanup-native-qualification/1", operator: "generated-handle-disposition-prototype", verdict, productionEnabled: false, candidateStopped: verdict === "Invalidated", stopReason, host, helper: helperIdentity, sources, limits: manifest.limits, actualScope: "One synthetic leaf and directory; not recursive or policy qualified", cases: results, matrix, harnessFailure: failure, smallestNextExperiment: verdict === "Invalidated" ? "Replace non-cooperative admitted-operation contract with enforceable bounded drain/fence contract. Prove first-cancel deadline with held pre-disposition actor before continuing recursion qualification. No production enabling." : "Two-leaf pre-open identity replacement and retained-object resource plan; no production enabling" }, null, 2));
    await fs.writeFile(path.join(output, "evidence-inventory.json"), JSON.stringify({ artifacts: await inventory(output), sources }, null, 2));
    t.diagnostic(`GENERATED LANE VERDICT: ${verdict}; productionEnabled=false; exact receipts ${output}`);
  }
});
