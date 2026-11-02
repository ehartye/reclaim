// Unforced Git is a separate lane. This fixture never weakens retained protection.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir, release, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { checkManifest } from "./fixtures/cleanup-identity/check-manifest.mjs";

const execute = promisify(execFile), repo = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function json(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; return null; } }
async function observe(file) {
  try { const stat = await fs.lstat(file, { bigint: true }); assert(stat.isFile() && !stat.isSymbolicLink()); const bytes = await fs.readFile(file); return { exists: true, ino: String(stat.ino), dev: String(stat.dev), bytes: bytes.length, sha256: digest(bytes) }; }
  catch (error) { if (error.code !== "ENOENT") throw error; return { exists: false }; }
}
async function files(dir, prefix = "") {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(path.join(dir, entry.name), relative + "/"));
    else if (relative !== "evidence-inventory.json") { const bytes = await fs.readFile(path.join(dir, entry.name)); result.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) }); }
  } return result;
}
let gitCandidateStopped = false, gitCandidateActive = false;
for (const scenario of ["observer-cancel", "ordinary", "descendant-survival"]) test(`Git lane ${scenario}: owned supervision, actual evidence and no promotion`, { skip: process.platform !== "win32" ? "Windows-only fixture; other lanes unsupported" : false, timeout: 180000 }, async (t) => {
  if (gitCandidateStopped || gitCandidateActive) { t.skip("Earlier candidate failed or native authority remains unresolved; no successor mutator"); return; }
  gitCandidateActive = true;
  const manifest = await checkManifest(), runId = randomUUID();
  const output = path.join(repo, "review", "cleanup-identity", `git-${scenario}-${runId}`);
  await fs.mkdir(output, { recursive: true });
  const sources = [], helper = path.join(output, "git-identity.exe");
  let fixture = null, owned = null, canonical = null, temporary = null, drained = false, started = false, running = null, processResult = null;
  let prepared = null, before = null, after = null, native = null, worker = null, outcome = null, verdict = "Partial", reason = "No completed Git observation", failure = null, gitIdentity = null, helperIdentity = null;
  try {
    for (const relative of ["tests/fixtures/cleanup-identity/git-native-supervision.cs", "tests/fixtures/cleanup-identity/git-operator.cs", "tests/fixtures/cleanup-identity/build-git-native.ps1", "tests/cleanup-git-qualification.test.mjs", "tests/fixtures/cleanup-identity/manifest.json"]) {
      const bytes = await fs.readFile(path.join(repo, relative)); sources.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
      const target = path.join(output, "source", relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    }
    const build = await execute("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "tests/fixtures/cleanup-identity/build-git-native.ps1"), "-OutputDirectory", output], { windowsHide: true, timeout: 30000 });
    await fs.writeFile(path.join(output, "build.txt"), build.stdout + build.stderr);
    const helperBytes = await fs.readFile(helper); helperIdentity = { bytes: helperBytes.length, sha256: digest(helperBytes) };
    const gitPath = (await execute("where.exe", ["git.exe"], { windowsHide: true, timeout: 10000 })).stdout.trim().split(/\r?\n/)[0];
    assert(path.isAbsolute(gitPath) && path.basename(gitPath).toLowerCase() === "git.exe");
    const gitBytes = await fs.readFile(gitPath); gitIdentity = { path: gitPath, bytes: gitBytes.length, sha256: digest(gitBytes), version: (await execute(gitPath, ["--version"], { windowsHide: true, timeout: 10000 })).stdout.trim() };
    fixture = await fs.mkdtemp(path.join(tmpdir(), "reclaim-cleanup-git-"));
    owned = await fs.lstat(fixture, { bigint: true }); canonical = await fs.realpath(fixture); temporary = await fs.realpath(tmpdir());
    assert(canonical.startsWith(`${temporary}${path.sep}`));
    await fs.writeFile(path.join(fixture, "fixture.marker"), runId); await fs.writeFile(path.join(fixture, "git-path.txt"), gitPath);
    await fs.writeFile(path.join(fixture, "scenario.txt"), scenario);
    await fs.mkdir(path.join(fixture, "outside-preview")); await fs.writeFile(path.join(fixture, "outside-preview", "sentinel"), "independent unselected sentinel\n");
    const sentinelBefore = await observe(path.join(fixture, "outside-preview", "sentinel"));
    let settled = false;
    running = execute(helper, ["supervisor", fixture, "held-git-remove"], { windowsHide: true, maxBuffer: 128000 })
      .then((r) => ({ exitCode: 0, stdout: r.stdout, stderr: r.stderr }))
      .catch((e) => ({ exitCode: e.code ?? null, stdout: e.stdout ?? "", stderr: e.stderr ?? "", error: e.message }))
      .then((r) => { settled = true; return r; });
    started = true;
    let observerFailure = null;
    try {
      while (!settled) {
        const ready = await fs.access(path.join(fixture, "observer-ready")).then(() => true).catch((error) => { if (error.code !== "ENOENT") throw error; return false; });
        if (ready) {
          prepared = await json(path.join(fixture, "prepared.json"));
          assert(prepared, "Observer-ready follows a closed prepared receipt");
          before = { sentinel: sentinelBefore, selected: {}, unselected: {}, refs: {}, registration: await files(path.join(fixture, "repo", ".git", "worktrees")) };
          for (const entry of prepared.entries) { assert(!/[\\/]/.test(entry.name)); before.selected[entry.name] = await observe(path.join(fixture, "selected-worktree", entry.name)); }
          for (const relative of ["repo/dist/output.bin", "repo/private.local"]) before.unselected[relative] = await observe(path.join(fixture, relative));
          for (const branch of ["fixture-main", "fixture-preserving-ref", "fixture-preserved"]) before.refs[branch] = await fs.readFile(path.join(fixture, "repo", ".git", "refs", "heads", branch), "utf8");
          await fs.writeFile(path.join(output, "independent-before.json"), JSON.stringify(before, null, 2));
          if (scenario === "observer-cancel") await fs.writeFile(path.join(fixture, "cancel"), "explicit observer cancellation");
          else await fs.writeFile(path.join(fixture, "observer-continue"), "independent observation complete");
          break;
        }
        await delay(20);
      }
    } catch (error) { observerFailure = error; await fs.writeFile(path.join(fixture, "cancel"), "observer failure"); }
    processResult = await running;
    await fs.writeFile(path.join(output, "process-result.json"), JSON.stringify(processResult, null, 2));
    await fs.mkdir(path.join(output, "native"));
    for (const entry of await fs.readdir(fixture, { withFileTypes: true })) if (entry.isFile()) await fs.copyFile(path.join(fixture, entry.name), path.join(output, "native", entry.name));
    native = await json(path.join(fixture, "supervisor.json"));
    const finalDrain = await json(path.join(fixture, "supervisor-finally-drain.json"));
    drained = (native?.primaryExited === true && native?.jobActive === 0) || (typeof processResult.exitCode === "number" && finalDrain?.originalWorkerExited === true && finalDrain?.jobActive === 0);
    worker = await json(path.join(fixture, "worker.json")); outcome = await json(path.join(fixture, "git-outcome.json"));
    after = { sentinel: await observe(path.join(fixture, "outside-preview", "sentinel")), selected: {}, unselected: {}, refs: {}, registration: await files(path.join(fixture, "repo", ".git", "worktrees")) };
    if (before) {
      for (const name of Object.keys(before.selected)) after.selected[name] = await observe(path.join(fixture, "selected-worktree", name));
      for (const relative of Object.keys(before.unselected)) after.unselected[relative] = await observe(path.join(fixture, relative));
      for (const branch of Object.keys(before.refs)) after.refs[branch] = await fs.readFile(path.join(fixture, "repo", ".git", "refs", "heads", branch), "utf8");
    }
    const remove = worker?.gitRuns?.find((run) => run.label === "remove-with-required-handles");
    const sharing = worker?.trace?.find((event) => event.event === "required-target-delete-open-probe");
    if (native?.candidateLifetimeBreach) { verdict = "Invalidated"; reason = "Original worker proof handles ended while an admitted owned descendant remained capable of DELETE access; strategy discarded"; }
    else if (native?.watchdogMissed) { verdict = "Invalidated"; reason = "Git candidate missed required drain deadline; operation interrupted"; }
    else if (scenario === "observer-cancel" && worker?.status === "interrupted") { reason = "Cooperative explicit observer cancellation started the first-stop deadline and stopped Git admission; bounded drain observed"; }
    else if (prepared?.selectedStatusBefore === "" && remove?.exitCode !== 0 && remove && /permission denied|access is denied|unable to unlink|cannot remove|directory not empty/i.test(remove.stderr) && sharing?.success === false && sharing?.nativeError === 32) {
      verdict = "Invalidated"; reason = "Verified clean linked worktree: required retained-object sharing prevents the unforced Git operator from removing it";
    } else if (remove?.exitCode === 0 && after.selected["README.md"]?.exists) { verdict = "Invalidated"; reason = "Git reported success while selected retained worktree files remain"; }
    else { reason = remove ? "Observed Git result does not settle causal protection compatibility; no weaker retry" : "No Git removal result; native/setup refusal preserved"; }
    if (verdict === "Invalidated") gitCandidateStopped = true;
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify({ scenario, verdict, reason, fixture, prepared, before, after, native, finalDrain, worker, outcome, processResult, sharing }, null, 2));
    assert(drained, "Original worker exit and zero Job members required before teardown");
    if (observerFailure) throw observerFailure;
    assert.equal(native.fileSystem, "NTFS"); assert(prepared && before, "Closed prepared and independent observation required");
    assert.equal(prepared.selectedStatusBefore, "", "Dirty target cannot establish protection incompatibility");
    assert.deepEqual(after.sentinel, before.sentinel); assert.deepEqual(after.unselected, before.unselected);
    assert.deepEqual(after.refs, before.refs, "Independent preserving branch bytes remain exact");
    assert.deepEqual(after.registration.sort((a,b) => a.path.localeCompare(b.path)), before.registration.sort((a,b) => a.path.localeCompare(b.path)), "Independent registration bytes remain exact");
    assert.deepEqual(after.selected, before.selected, "Selected identities and bytes remain unchanged");
    if (scenario === "ordinary") {
      assert.equal(processResult.exitCode, 0); assert.equal(native.watchdogMissed, false); assert(remove && outcome);
      assert.equal(outcome.refsAfter, outcome.refsBefore); assert.equal(outcome.registrationAfter, outcome.registrationBefore);
      assert.equal(sharing.success, false); assert.equal(sharing.nativeError, 32);
      assert(remove.args.includes("remove") && !remove.args.some((arg) => arg === "--force" || arg === "-f"));
    } else if (scenario === "observer-cancel") {
      assert.equal(processResult.exitCode, 0); assert.equal(native.watchdogMissed, false); assert.equal(worker.status, "interrupted"); assert.equal(remove, undefined);
      assert(native.stopRequestedQpc, "Actual marker must start a native stop deadline");
      const stop = BigInt(native.stopRequestedQpc), elapsed = Number(BigInt(native.drainObservedQpc)-stop)*1000/Number(native.qpcFrequency);
      assert(elapsed < 5000, `Cooperative first-stop drain ${elapsed}ms`);
      assert(worker.trace.filter((event) => event.event === "git-admitted").every((event) => BigInt(event.qpc)<stop), "No Git admission after first stop");
    } else {
      assert.equal(processResult.exitCode, 2); assert.equal(native.strategyVerdict, "Invalidated"); assert.equal(native.candidateLifetimeBreach, true); assert.equal(native.watchdogMissed, true); assert.equal(remove, undefined);
      assert.equal(native.operationReceipt.status, "interrupted"); assert.equal(native.operationReceipt.deletedFiles, null);
      const probe = await json(path.join(fixture, "descendant-probe.json")), stopRequest = await json(path.join(fixture, "stop-request.json"));
      assert.equal(probe.success, true); assert.equal(probe.identity.fileId, prepared.targetIdentity.fileId); assert.equal(probe.identity.volume, prepared.targetIdentity.volume);
      assert.match(stopRequest.reason, /^command-budget:injected-descendant-survival$/);
      assert.equal(native.stopRequestedQpc, stopRequest.requestedQpc, "Internal command-budget stop timestamp is preserved exactly");
      const missed = native.trace.find((event) => event.event === "drain-watchdog-missed");
      const elapsed = Number(BigInt(missed.qpc)-BigInt(stopRequest.requestedQpc))*1000/Number(native.qpcFrequency);
      assert(elapsed >= 5000 && elapsed < 15000, `Internal first-stop watchdog ${elapsed}ms`);
      assert(await json(path.join(fixture, "candidate-invalidated.json")), "Lifetime violation is durable before teardown");
    }
    t.diagnostic(`GIT LANE VERDICT: ${verdict}; ${reason}; no protection weakening or retry`);
  } catch (error) { gitCandidateStopped = true; failure = { message: error.message, stack: error.stack }; throw error; }
  finally {
    // Native supervision remains responsible for its Job on every exit path.
    // An unexpected observer failure must not discard a still-running supervisor.
    if (running && !processResult) { processResult = await running; await fs.writeFile(path.join(output, "process-result.json"), JSON.stringify(processResult, null, 2)); }
    if (fixture) {
      if (drained) {
        const current = await fs.lstat(fixture, { bigint: true }); assert(!current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino); assert.equal(await fs.realpath(fixture), canonical);
        assert(canonical.startsWith(`${temporary}${path.sep}`) && path.basename(fixture).startsWith("reclaim-cleanup-git-"));
        await fs.rm(fixture, { recursive: true, force: true });
        await fs.writeFile(path.join(output, "teardown.json"), JSON.stringify({ fixture, strictDrainObserved: true, removed: true }));
      } else await fs.writeFile(path.join(output, "retained-fixture.json"), JSON.stringify({ fixture, started, reason: "Strict native drain not established; retain supervision/fixture, prohibit successor mutator" }));
    }
    const failedCases = ["cancel","helper-failure","process-death","drain-watchdog"];
    const matrix = manifest.requiredCases.map((name) => ({ case: name, verdict: scenario === "descendant-survival" && verdict === "Invalidated" && failedCases.includes(name) ? "Invalidated" : "Partial", evidence: name === "external-conflicting-handle" && scenario === "ordinary" ? reason : failedCases.includes(name) && scenario !== "ordinary" ? reason : name === "git-registration-and-branch-preservation" ? "Independent refs and registration bytes captured before/after; exact observations in receipt" : name === "git-ignored-or-unknown-content" ? "Unselected ignored/unknown synthetic data preserved; selected-content races unresolved" : "Not exercised in this fixed scenario; no promotion" }));
    await fs.writeFile(path.join(output, "git-qualification.json"), JSON.stringify({ schema: "reclaim.cleanup-git-qualification/1", scenario, operator: "unforced-git-worktree-remove-with-worker-owned-retained-handles", verdict, reason, productionEnabled: false, candidateStopped: verdict === "Invalidated", host: { platform: process.platform, osRelease: release(), architecture: arch(), node: process.version, fileSystem: native?.fileSystem ?? null, volumeSerial: native?.volumeSerial ?? null }, git: gitIdentity, helper: helperIdentity, sources, limits: manifest.limits, matrix, harnessFailure: failure, smallestNextExperiment: "Discard worker-owned proof lifetime strategy. A new supervisor/broker ownership design must retain proof authority until every admitted descendant is independently terminal; no weaker handles, force, path fallback or promotion." }, null, 2));
    await fs.writeFile(path.join(output, "evidence-inventory.json"), JSON.stringify({ artifacts: await files(output), sources }, null, 2));
    if (drained || !started) gitCandidateActive = false;
    t.diagnostic(`Git exact evidence: ${output}`);
  }
});
