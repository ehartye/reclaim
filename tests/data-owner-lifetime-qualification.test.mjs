// A green test qualifies WP1's evidence harness, never a production owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir, release, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const hash = b => createHash('sha256').update(b).digest('hex');
const sourcePaths = ['tests/data-owner-lifetime-qualification.test.mjs', 'tests/fixtures/data-owner-lifetime/build-native.ps1', 'tests/fixtures/data-owner-lifetime/native-harness.cs', 'tests/fixtures/data-owner-lifetime/sequential-worker.mjs', 'server/app.mjs'];
async function optional(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } }
async function observe(file) {
  try { const stat = await fs.lstat(file, { bigint: true }); assert(stat.isFile() && !stat.isSymbolicLink()); const b = await fs.readFile(file); return { exists: true, dev: String(stat.dev), ino: String(stat.ino), bytes: b.length, sha256: hash(b) }; }
  catch (e) { if (e.code !== 'ENOENT') throw e; return { exists: false }; }
}
async function inventory(dir, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await inventory(path.join(dir, entry.name), relative + '/'));
    else if (relative !== 'evidence-inventory.json') { const b = await fs.readFile(path.join(dir, entry.name)); result.push({ path: relative, bytes: b.length, sha256: hash(b) }); }
  }
  return result;
}
async function copyTree(source, target) { await fs.cp(source, target, { recursive: true, errorOnExist: true }); }

test('WP1 observes sequential state loss and actual helper-loss authority overlap in owned native containers', { skip: process.platform !== 'win32' && 'Windows fixture only', timeout: 240000 }, async t => {
  const runId = randomUUID(), output = path.join(repo, 'review/data-owner-lifetime', runId);
  await fs.mkdir(output, { recursive: true });
  const sources = [], rows = [];
  let failure = null, helperIdentity = null;
  const helper = path.join(output, 'data-owner-lifetime.exe');
  // This independent sentinel is a sibling of fixture roots, never passed to
  // native actors or the production API and never inside a mutated directory.
  const sentinelRoot = await fs.mkdtemp(path.join(tmpdir(), 'reclaim-owner-sentinel-'));
  const sentinel = path.join(sentinelRoot, 'sentinel');
  await fs.writeFile(sentinel, `independent synthetic sentinel ${runId}`);
  const sentinelBefore = await observe(sentinel);
  let allDrained = true;
  try {
    for (const relative of sourcePaths) {
      const b = await fs.readFile(path.join(repo, relative)); sources.push({ path: relative, bytes: b.length, sha256: hash(b) });
      const target = path.join(output, 'source', relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, b);
    }
    const build = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tests/fixtures/data-owner-lifetime/build-native.ps1'), '-OutputDirectory', output], { windowsHide: true, timeout: 30000 });
    await fs.writeFile(path.join(output, 'build.txt'), build.stdout + build.stderr);
    const helperBytes = await fs.readFile(helper); helperIdentity = { bytes: helperBytes.length, sha256: hash(helperBytes) };
    // Negative helper-loss baseline is last. Any unexpected failure aborts this
    // run; there is no automatic rerun and no successor while exit is uncertain.
    for (const name of ['sequential', 'control', 'notification-loss', 'malformed-request', 'interrupted-request', 'uncertain-write-failure', 'deadline-write-failure', 'helper-loss']) {
      const fixture = await fs.mkdtemp(path.join(tmpdir(), 'reclaim-owner-lifetime-'));
      const owned = await fs.lstat(fixture, { bigint: true }), canonical = await fs.realpath(fixture), temporary = await fs.realpath(tmpdir());
      assert(canonical.startsWith(temporary + path.sep));
      await fs.writeFile(path.join(fixture, 'fixture.marker'), runId);
      await fs.writeFile(path.join(fixture, 'disposable-payload'), 'disposable admitted mutation bytes');
      const caseOutput = path.join(output, name); await fs.mkdir(caseOutput);
      let drained = false, processResult = null;
      allDrained = false;
      try {
        const args = ['supervisor', fixture, name];
        if (name === 'sequential') args.push(process.execPath, path.join(repo, 'tests/fixtures/data-owner-lifetime/sequential-worker.mjs'));
        // Never attach a JS kill timeout: native 60/5 limits retain the owned
        // Job and original handles through terminal drain, even on test timeout.
        processResult = await execute(helper, args, { windowsHide: true, maxBuffer: 128000 })
          .then(r => ({ exitCode: 0, stdout: r.stdout, stderr: r.stderr }))
          .catch(e => ({ exitCode: e.code ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '', error: e.message }));
        await fs.writeFile(path.join(caseOutput, 'process-result.json'), JSON.stringify(processResult, null, 2));
        await copyTree(fixture, path.join(caseOutput, 'raw'));
        const supervisor = await optional(path.join(fixture, 'supervisor.json'));
        const terminal = await optional(path.join(fixture, 'terminal-drain.json'));
        const observer = await optional(path.join(fixture, 'observer.json'));
        drained = typeof processResult.exitCode === 'number' && terminal?.originalHandlesExited === true && terminal?.jobActive === 0 && terminal.actors.every(a => a.originalHandleExited === true);
        allDrained = drained;
        const sentinelAfter = await observe(sentinel);
        const row = { case: name, processResult, supervisor, terminal, observer, fixture, strictDrain: drained, sentinelBefore, sentinelAfter };
        rows.push(row);
        await fs.writeFile(path.join(caseOutput, 'receipt.json'), JSON.stringify(row, null, 2));
        assert(drained, 'Exact original-handle exit plus exact Job zero required; otherwise retain fixture');
        assert.deepEqual(sentinelAfter, sentinelBefore);
        assert.equal(supervisor.candidate, false);
        if (['notification-loss', 'malformed-request', 'interrupted-request', 'uncertain-write-failure', 'deadline-write-failure'].includes(name)) {
          // Expected hostile inputs are isolated counterexamples. Continue only
          // after exact native exit/drain proof and the expected fail-closed
          // result; any unexpected outcome aborts before a successor starts.
          assert.equal(processResult.exitCode, 2);
          assert.equal(supervisor.completed, false); assert.equal(supervisor.operationStatus, 'interrupted');
          assert.equal(supervisor.strategyVerdict, 'Invalidated');
          assert(supervisor.terminationAttempts > 0 && supervisor.terminationSuccesses > 0);
          assert.equal(supervisor.terminationObligationSatisfied, true);
          assert(supervisor.cancelAttempts > 0);
          assert.equal(await fs.readFile(path.join(fixture, 'disposable-payload'), 'utf8'), 'disposable admitted mutation bytes');
          assert.deepEqual(await observe(path.join(fixture, 'state.json')), { exists: false });
          const trace = (await fs.readFile(path.join(fixture, 'supervisor.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
          if (name === 'notification-loss' || name === 'deadline-write-failure') {
            const request = await optional(path.join(fixture, 'requester-cancel-request.json'));
            const first = trace.find(e => e.event === 'first-stop');
            const killed = trace.find(e => e.event === 'requester-native-death-injected');
            const missed = await optional(path.join(fixture, 'deadline-missed.json'));
            assert.equal(first.cause, 'durable-cancel-request');
            assert.equal(first.requestedQpc, request.requestedQpc);
            assert.equal(supervisor.firstStopQpc, request.requestedQpc);
            assert.equal(killed.latchedStopQpc, request.requestedQpc);
            assert(BigInt(killed.qpc) > BigInt(first.qpc));
            assert.equal(supervisor.stopTimestampUncertain, false); assert.equal(supervisor.deadlineMissed, true);
            if (name === 'notification-loss') assert.equal(missed.firstStopQpc, request.requestedQpc);
            else assert.equal(missed, null, 'Explicit injected failure must prevent the target diagnostic write');
            const missedQpc = missed?.observedQpc ?? trace.find(e => e.event === 'drain-deadline-missed').qpc;
            const elapsed = Number(BigInt(missedQpc) - BigInt(request.requestedQpc)) * 1000 / Number(supervisor.qpcFrequency);
            assert(elapsed >= 5000 && elapsed < 9000, `Original receipt starts watchdog: ${elapsed}ms`);
            const requester = (await fs.readFile(path.join(fixture, 'requester.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
            assert(!requester.some(e => e.event === 'barrier-signaled' && e.name === 'observer-cancel'));
            assert(terminal.actors.some(a => a.role === 'requester' && a.exitCode === 78));
          } else {
            const uncertain = await optional(path.join(fixture, 'stop-uncertain.json'));
            assert.equal(supervisor.stopTimestampUncertain, true);
            assert.equal(supervisor.firstStopQpc, null, 'Unknown request must not receive a fresh inferred deadline');
            assert.equal(supervisor.deadlineMissed, false);
            if (name === 'uncertain-write-failure') assert.equal(uncertain, null, 'Explicit injected failure must prevent the target diagnostic write');
            else {
              assert.equal(uncertain.timestampUncertain, true); assert.equal(uncertain.strategyVerdict, 'Invalidated');
              assert.match(uncertain.action, /Immediate owned-Job termination/);
            }
            assert(!trace.some(e => e.event === 'first-stop'), 'Uncertain request cannot restart the clock');
          }
          if (name.endsWith('write-failure')) {
            assert.equal(supervisor.diagnosticFailure, true);
            const fallback = (await fs.readFile(path.join(fixture, 'diagnostic-fallback.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
            const expectedTarget = name === 'uncertain-write-failure' ? 'stop-uncertain.json' : 'deadline-missed.json';
            assert(fallback.some(e => e.target === expectedTarget && /Injected diagnostic write failure/.test(e.error) && e.strategyVerdict === 'Invalidated'));
            assert(terminal.actors.some(a => a.role === 'blocked' && a.exitCode === 99), 'Logging failure cannot suppress owned termination');
          } else assert.equal(supervisor.diagnosticFailure, false);
        } else if (name === 'sequential') {
          assert.equal(processResult.exitCode, 0); assert.equal(supervisor.completed, true); assert.equal(supervisor.deadlineMissed, false);
          const afterA = await optional(path.join(fixture, 'after-A.json')), afterB = await optional(path.join(fixture, 'after-B.json'));
          assert.deepEqual(afterA.settings.exclusions, ['owner-A-preserve-this']);
          assert.deepEqual(afterB.settings.exclusions, []); assert.equal(afterB.settings.staleDays, 123);
          const result = await optional(path.join(fixture, 'sequential-result.json'));
          assert.equal(new Set(result.ports).size, 2); assert(result.ports.every(p => p > 0 && p !== 4318));
        } else {
          assert.equal(processResult.exitCode, 0); assert.equal(supervisor.completed, true); assert.equal(supervisor.deadlineMissed, false);
          assert.equal(observer.overlap, name === 'helper-loss');
          assert.equal(observer.BLeaseIndependentlyBusy, true);
          assert.equal(observer.actualStateBytes, 'A-published'); assert.equal(observer.actualPayloadPresent, false);
          assert.equal(supervisor.strategyVerdict, name === 'helper-loss' ? 'Invalidated' : 'Partial');
          const traces = {};
          for (const actor of ['supervisor', 'helper', 'writer', 'mutator', 'contender', 'observer']) traces[actor] = (await fs.readFile(path.join(fixture, actor + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
          const acquired = traces.contender.find(e => e.event === 'authority-acquired');
          const published = traces.writer.find(e => e.event === 'actual-state-publication-returned');
          const mutated = traces.mutator.find(e => e.event === 'actual-mutation-returned');
          const observed = traces.observer.find(e => e.event === 'independent-actual-publication-observed');
          const released = traces.contender.find(e => e.event === 'authority-releasing');
          assert(BigInt(observed.qpc) < BigInt(released.qpc), 'Actual bytes observed while B retains authority');
          for (const event of [published, mutated]) assert.equal(BigInt(event.qpc) > BigInt(acquired.qpc), name === 'helper-loss');
          if (name === 'helper-loss') { assert.equal(acquired.abandoned, true); assert.equal(supervisor.firstStopCause, 'actor-exit:helper'); }
        }
        t.diagnostic(`${name}: strict drain and outside sentinel verified; ${name === 'helper-loss' ? 'rejected prototype Invalidated by actual overlap' : 'baseline/control or expected fail-closed fault observed'}`);
      } finally {
        if (drained) {
          const current = await fs.lstat(fixture, { bigint: true });
          assert(!current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino);assert.equal(await fs.realpath(fixture), canonical);
          assert(canonical.startsWith(temporary + path.sep) && path.basename(canonical).startsWith('reclaim-owner-lifetime-'));
          await fs.rm(fixture, { recursive: true, force: true });
          await fs.writeFile(path.join(caseOutput, 'teardown.json'), JSON.stringify({ fixture, strictDrain: true, removed: true }));
        } else await fs.writeFile(path.join(caseOutput, 'retained-fixture.json'), JSON.stringify({ fixture, strictDrain: false, noSuccessor: true, reason: 'Authority/exit unknown; preserve fixtures and native supervision; no automatic retry' }));
      }
    }
  } catch (e) { failure = { message: e.message, stack: e.stack }; throw e; }
  finally {
    const sentinelAfter = await observe(sentinel);
    await fs.writeFile(path.join(output, 'wp1-qualification.json'), JSON.stringify({ schema: 'reclaim.owner-lifetime-wp1/1', productionEnabled: false, candidate: false, verdict: failure ? 'Invalidated' : 'WP1-counterexamples-observed', rejectedHelperOnlyVerdict: rows.find(r => r.case === 'helper-loss')?.supervisor?.strategyVerdict ?? 'Unresolved', host: { platform: process.platform, release: release(), architecture: arch(), node: process.version }, helper: helperIdentity, sources, rows, failure, sentinel: { root: sentinelRoot, before: sentinelBefore, after: sentinelAfter }, limits: { operationSeconds: 60, firstStopDrainSeconds: 5 }, nextGate: 'Fresh WP1 review before any WP2 candidate work' }, null, 2));
    await fs.writeFile(path.join(output, 'evidence-inventory.json'), JSON.stringify({ artifacts: await inventory(output), sources }, null, 2));
    // Retain the independent sentinel when a fixture lifetime is unresolved.
    if (allDrained) { assert.deepEqual(sentinelAfter, sentinelBefore); await fs.unlink(sentinel); await fs.rmdir(sentinelRoot); }
    t.diagnostic(`WP1 exact evidence: ${output}; productionEnabled=false; no qualified owner candidate`);
  }
});
