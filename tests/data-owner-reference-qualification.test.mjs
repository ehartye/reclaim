// WP2 private candidate evidence, never a product ownership test or activation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir, release, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

const execute = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
const digest = b => createHash('sha256').update(b).digest('hex');
const sourcePaths = [
  'tests/data-owner-reference-qualification.test.mjs', 'tests/fixtures/data-owner-lifetime/reference-candidate.cs',
  'tests/fixtures/data-owner-lifetime/build-candidate.ps1', 'tests/fixtures/data-owner-lifetime/candidate-contract.json',
  'tests/fixtures/data-owner-lifetime/native-harness.cs', 'tests/fixtures/data-owner-lifetime/build-native.ps1',
  'tests/data-owner-lifetime-qualification.test.mjs', 'tests/fixtures/data-owner-lifetime/sequential-worker.mjs', 'server/app.mjs',
];
const required = ['helper-loss-held-state-writer-and-mutator', 'node-parent-death-with-survivors', 'each-worker-failure', 'canonical-alias-same-physical-directory', 'different-ports-and-entry-points', 'independent-physical-directories', 'root-and-ancestor-replacement', 'abandoned-acquisition-versus-consistency', 'corrupt-recovery', 'ambiguous-or-unsupported-recovery', 'initialization-failure', 'listen-failure', 'cancel', 'blocked-drain', 'native-adapter-failure', 'seeded-contention'];
async function optional(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } }
async function observe(file) {
  try { const s = await fs.lstat(file, { bigint: true }); assert(s.isFile() && !s.isSymbolicLink()); const b = await fs.readFile(file); return { exists: true, dev: String(s.dev), ino: String(s.ino), bytes: b.length, sha256: digest(b) }; }
  catch (e) { if (e.code !== 'ENOENT') throw e; return { exists: false }; }
}
async function inventory(dir, prefix = '') {
  const rows = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) rows.push(...await inventory(path.join(dir, e.name), prefix + e.name + '/'));
    else if (prefix + e.name !== 'evidence-inventory.json') { const b = await fs.readFile(path.join(dir, e.name)); rows.push({ path: prefix + e.name, bytes: b.length, sha256: digest(b) }); }
  }
  return rows;
}
const regressionId = process.env.RECLAIM_OWNER_WP1_REGRESSION;
test('WP2 duplicates physical lease references and tests helper death plus ancestor replacement', { skip: process.platform !== 'win32' ? 'Windows NTFS native fixture only' : !regressionId ? 'Explicit current WP1 regression receipt required for private candidate' : false, timeout: 180000 }, async t => {
  assert(/^[a-f0-9-]{36}$/.test(regressionId), 'Exact current regression run UUID required');
  const regressionRoot = path.join(repo, 'review/data-owner-lifetime', regressionId);
  const regression = await optional(path.join(regressionRoot, 'wp1-qualification.json'));
  assert.equal(regression.failure, null); assert.equal(regression.rows.length, 8);
  assert(regression.rows.every(r => r.strictDrain)); assert.equal(regression.rejectedHelperOnlyVerdict, 'Invalidated');
  for (const e of regression.sources) { const b = await fs.readFile(path.join(repo, e.path)); assert.equal(b.length, e.bytes); assert.equal(digest(b), e.sha256, 'Baseline regression must bind current source'); }
  const regressionInventory = await fs.readFile(path.join(regressionRoot, 'evidence-inventory.json'));
  for (const e of JSON.parse(regressionInventory).artifacts) { const b = await fs.readFile(path.join(regressionRoot, e.path)); assert.equal(b.length, e.bytes); assert.equal(digest(b), e.sha256); }

  const id = randomUUID(), output = path.join(repo, 'review/data-owner-lifetime', 'candidate-' + id);
  await fs.mkdir(output, { recursive: true });
  const helper = path.join(output, 'owner-reference-candidate.exe'), sources = [], rows = [];
  const sentinelRoot = await fs.mkdtemp(path.join(tmpdir(), 'reclaim-owner-sentinel-'));
  const sentinel = path.join(sentinelRoot, 'sentinel'); await fs.writeFile(sentinel, `independent WP2 sentinel ${id}`);
  const sentinelBefore = await observe(sentinel);
  let allDrained = true, failure = null, verdict = 'Partial', helperIdentity = null;
  try {
    for (const relative of sourcePaths) { const b = await fs.readFile(path.join(repo, relative)); sources.push({ path: relative, bytes: b.length, sha256: digest(b) }); const target = path.join(output, 'source', relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, b); }
    const build = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tests/fixtures/data-owner-lifetime/build-candidate.ps1'), '-OutputDirectory', output], { windowsHide: true, timeout: 30000 });
    await fs.writeFile(path.join(output, 'build.txt'), build.stdout + build.stderr);
    const helperBytes = await fs.readFile(helper); helperIdentity = { bytes: helperBytes.length, sha256: digest(helperBytes) };
    for (const name of ['reference-helper-loss', 'ancestor-replacement']) {
      const fixture = await fs.mkdtemp(path.join(tmpdir(), 'reclaim-owner-lifetime-'));
      const owned = await fs.lstat(fixture, { bigint: true }), canonical = await fs.realpath(fixture), temporary = await fs.realpath(tmpdir());
      assert(canonical.startsWith(temporary + path.sep));
      const data = path.join(fixture, 'namespace/parent/data'); await fs.mkdir(data, { recursive: true });
      await fs.writeFile(path.join(fixture, 'fixture.marker'), id);
      await fs.writeFile(path.join(data, 'state.json'), 'legacy-synthetic-recovery-unknown');
      await fs.copyFile(path.join(data, 'state.json'), path.join(fixture, 'before-state.json'));
      await fs.writeFile(path.join(data, 'disposable-payload'), 'original-disposable-payload');
      await fs.writeFile(path.join(data, 'owner.lease'), 'fixture lease file; never a consistency claim');
      const caseOutput = path.join(output, name); await fs.mkdir(caseOutput);
      let drained = false;
      allDrained = false;
      try {
        // Native supervision owns 60/5 budgets. Never kill the supervisor on a
        // JS/test timeout, and never start a successor on unknown exit/drain.
        const processResult = await execute(helper, ['supervisor', fixture, name], { windowsHide: true, maxBuffer: 128000 })
          .then(r => ({ exitCode: 0, stdout: r.stdout, stderr: r.stderr }))
          .catch(e => ({ exitCode: e.code ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '', error: e.message }));
        await fs.writeFile(path.join(caseOutput, 'process-result.json'), JSON.stringify(processResult, null, 2));
        const terminal = await optional(path.join(fixture, 'terminal-drain.json'));
        drained = typeof processResult.exitCode === 'number' && terminal?.originalHandlesExited === true && terminal.jobActive === 0 && terminal.actors.every(a => a.originalHandleExited);
        allDrained = drained;
        await fs.cp(fixture, path.join(caseOutput, 'raw'), { recursive: true, errorOnExist: true });
        const supervisor = await optional(path.join(fixture, 'candidate-supervisor.json'));
        const observer = await optional(path.join(fixture, 'candidate-observer.json'));
        const replacement = await optional(path.join(fixture, 'namespace-replacement.json'));
        const sentinelAfter = await observe(sentinel);
        const row = { case: name, fixture, processResult, terminal, supervisor, observer, replacement, strictDrain: drained, sentinelBefore, sentinelAfter };
        rows.push(row);
        if (supervisor?.strategyVerdict === 'Invalidated') verdict = 'Invalidated';
        await fs.writeFile(path.join(caseOutput, 'receipt.json'), JSON.stringify(row, null, 2));
        assert(drained, 'Unknown lifetime: fixture retained and no successor'); assert.deepEqual(sentinelAfter, sentinelBefore);
        assert.equal(processResult.exitCode, 0, 'Preserved failed native run; no automatic retry');
        assert.equal(supervisor.completed, true); assert.equal(supervisor.deadlineMissed, false); assert.equal(supervisor.diagnosticFailure, false);
        const pending = await optional(path.join(fixture, 'stop-pending.json'));
        assert.equal(pending.strategyVerdict, 'Partial', 'Expected helper death cannot silently import the rejected baseline verdict');
        assert.equal(supervisor.host.filesystem, 'NTFS'); assert.equal(supervisor.candidate, true); assert.equal(supervisor.productionEnabled, false);
        assert.equal(observer.firstAttemptWhileBothAActorsAlive, true); assert.equal(observer.BLeaseIndependentlyBusy, true);
        assert.equal(observer.actualStateBytes, 'candidate-A-published'); assert.equal(observer.actualPayloadPresent, false);
        const trace = {};
        for (const actor of ['supervisor', 'writer', 'mutator', 'contender', 'observer']) trace[actor] = (await fs.readFile(path.join(fixture, actor + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        const acquired = trace.contender.find(e => e.event === 'authority-acquired');
        const published = trace.writer.find(e => e.event === 'actual-state-publication-returned');
        const mutated = trace.mutator.find(e => e.event === 'actual-mutation-returned');
        const observed = trace.observer.find(e => e.event === 'independent-actual-publication-observed');
        const releasing = trace.contender.find(e => e.event === 'authority-releasing');
        assert(BigInt(observed.qpc) < BigInt(releasing.qpc));
        const expectedOverlap = name === 'ancestor-replacement' && replacement.moved;
        assert.equal(observer.overlap, expectedOverlap);
        for (const event of [published, mutated]) assert.equal(BigInt(event.qpc) > BigInt(acquired.qpc), expectedOverlap);
        const leaseIds = await Promise.all(['helper', 'writer', 'mutator'].map(async role => (await optional(path.join(fixture, role + '-lease.json'))).identity));
        assert.deepEqual(leaseIds[0], leaseIds[1]); assert.deepEqual(leaseIds[0], leaseIds[2]);
        assert(trace.supervisor.some(e => e.event === 'controller-reference-closed-after-handoff'));
        if (expectedOverlap) {
          assert.notDeepEqual(replacement.before, replacement.after); assert.deepEqual(replacement.before, replacement.retiredIdentity);
          const authority = await optional(path.join(fixture, 'B-authority.json'));
          assert.notDeepEqual(authority.leaseIdentity, leaseIds[0]);
          assert.deepEqual(authority.directoryIdentity, replacement.after);
          assert.equal(supervisor.strategyVerdict, 'Invalidated');
          assert(await optional(path.join(fixture, 'candidate-invalidated.json')));
        } else { assert.equal(observer.BFirstAttempt.acquired, false); assert.equal(observer.BFirstAttempt.nativeError, 32); assert.equal(supervisor.strategyVerdict, 'Partial'); }
        t.diagnostic(`${name}: ${supervisor.strategyVerdict}; ${expectedOverlap ? 'actual namespace/authority overlap; candidate stopped' : 'held actors retained exclusive physical lease'}; strict drain and sentinel unchanged`);
      } finally {
        if (drained) { const current = await fs.lstat(fixture, { bigint: true }); assert(!current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino); assert.equal(await fs.realpath(fixture), canonical); assert(canonical.startsWith(temporary + path.sep) && path.basename(canonical).startsWith('reclaim-owner-lifetime-')); await fs.rm(fixture, { recursive: true, force: true }); await fs.writeFile(path.join(caseOutput, 'teardown.json'), JSON.stringify({ fixture, strictDrain: true, removed: true })); }
        else await fs.writeFile(path.join(caseOutput, 'retained-fixture.json'), JSON.stringify({ fixture, strictDrain: false, noSuccessor: true, reason: 'Uncertain lifetime; retain owned supervision and fixture; no automatic retry' }));
      }
      if (verdict === 'Invalidated') break; // Never improve the verdict by continuing after a safety violation.
    }
  } catch (e) { failure = { message: e.message, stack: e.stack }; verdict = 'Invalidated'; throw e; }
  finally {
    const stopped = verdict === 'Invalidated';
    const matrix = required.map(name => {
      const row = name === 'helper-loss-held-state-writer-and-mutator' ? rows.find(r => r.case === 'reference-helper-loss') : name === 'root-and-ancestor-replacement' ? rows.find(r => r.case === 'ancestor-replacement') : null;
      return { case: name, verdict: row?.supervisor?.strategyVerdict ?? 'Partial', execution: row ? 'observed' : 'unqualified-not-run', evidence: row ? `${row.case}/receipt.json` : null, reason: row ? 'Exact observed schedule only; no general qualification inferred' : stopped ? 'Candidate stopped at first authority counterexample/failure; this case remains unqualified' : 'Bounded Partial exit: namespace identity/fencing remains unsettled; this case remains unqualified' };
    });
    const sentinelAfter = await observe(sentinel);
    await fs.writeFile(path.join(output, 'candidate-matrix.json'), JSON.stringify({ verdict, productionEnabled: false, candidateStopped: stopped, matrix }, null, 2));
    await fs.writeFile(path.join(output, 'draft-ownership-contract.json'), JSON.stringify({ ...JSON.parse(await fs.readFile(path.join(repo, 'tests/fixtures/data-owner-lifetime/candidate-contract.json'))), verdict, sourceIdentity: sources, helper: helperIdentity, observed: rows.map(r => ({ case: r.case, host: r.supervisor?.host, actorReferences: r.supervisor?.actors, authorityOverlap: r.observer?.overlap, strictDrain: r.strictDrain })), remainingCases: matrix.filter(r => r.execution === 'unqualified-not-run') }, null, 2));
    await fs.writeFile(path.join(output, 'candidate-qualification.json'), JSON.stringify({ schema: 'reclaim.owner-reference-wp2/1', verdict, productionEnabled: false, candidateStopped: stopped, strategy: 'Exclusive lease references held by every admitted actor; direct text-path writes', host: { platform: process.platform, osRelease: release(), architecture: arch(), node: process.version }, helper: helperIdentity, sources, regression: { run: regressionId, inventorySha256: digest(regressionInventory), exactCurrentSourcesVerified: true, strictDrain: true }, rows, matrix, failure, sentinel: { root: sentinelRoot, before: sentinelBefore, after: sentinelAfter }, limits: { operationSeconds: 60, firstStopDrainSeconds: 5 }, smallestNextExperiment: 'Before any further lifetime/alias/recovery qualification, bind or fence every publication/mutation to retained physical directory/ancestor identities, or use a broker that cannot follow replaced text paths. Prove the ancestor replacement schedule with actual bytes; no production enabling.', nextGate: 'Fresh WP2 review before WP3 independent verdict and handoff' }, null, 2));
    await fs.writeFile(path.join(output, 'evidence-inventory.json'), JSON.stringify({ artifacts: await inventory(output), sources }, null, 2));
    if (allDrained) { assert.deepEqual(sentinelAfter, sentinelBefore); await fs.unlink(sentinel); await fs.rmdir(sentinelRoot); }
    t.diagnostic(`WP2 ${verdict}; exact evidence ${output}; productionEnabled=false`);
  }
});
