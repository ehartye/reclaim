# Data-directory owner lifetime qualification

This fixture-only spike investigates authority across helper and parent failure.
It provides no production data-store ownership, recovery implementation or auth
change. A helper-only lock followed by asynchronous shutdown is a rejected
baseline. Acquiring an OS lease does not establish that persistent state is
consistent.

The required invariant is that B cannot acquire write or mutation authority while
any A actor can still publish state or continue admitted mutation. A usable
contract must name every actor, retained reference or fence, admission boundary,
actual publication event, stop obligation and terminal observation. Callback
completion, EOF, a stale PID and a lock's apparent availability are insufficient.

## Baseline harness

```powershell
node --test tests/data-owner-lifetime-qualification.test.mjs
```

The test creates unique synthetic temporary roots and an independent outside
sibling sentinel. The native supervisor creates children suspended, assigns and
verifies membership in a newly owned Job, and retains original creation handles.
No admitted mutator runs before containment. Existing named Jobs are refused.
All original handles must signal and exact Job accounting must reach zero before
fixture teardown. Unknown exit retains supervision and fixtures and prevents a
successor operation.

The recorded application's two-instance baseline loses A's saved exclusion when
B later saves an unrelated setting from its stale in-memory snapshot. A separate
native helper-only lease baseline holds an admitted writer and disposable mutator
across helper death. Independent observation sees B holding the lease while both
A actors remain alive, followed by actual A publication and mutation before B
releases authority. A no-overlap control distinguishes that failure. This rejects
the helper-only strategy; a green harness is not an ownership qualification.

Native actors and the independent observer use a shared QPC basis. Receipts retain
actual state bytes and hashes, mutation observations, exact process/lease identity,
before/after sentinel observations, original-handle exit and Job-zero evidence.
Application baseline observations are not silently treated as native-clock
timestamps. Exact helper/source snapshots and byte/hash inventories remain under
ignored `review/data-owner-lifetime/`.

The operation ceiling is 60 seconds. The first stop request starts one five-second
drain interval from the earliest valid native timestamp, without extension on
actor exit or notification delivery. Durable requests are inspected independently
of their wake-up event. Malformed or interrupted timestamp evidence remains
unknown and causes fail-closed owned termination rather than a fresh grace period.
Required cancellation and termination obligations contain no diagnostic I/O;
diagnostic failure cannot consume the obligation or suppress retries. Obligations
end only after independently observed terminal drain.

The baseline packet exercises notification loss plus requester death, malformed
and interrupted requests, and confined injected failures of uncertainty/deadline
diagnostic writes. Failed target diagnostics remain absent, fallback evidence is
retained, and owned termination still occurs. The fault injections do not fill a
disk or modify operating-system/user ACLs. Strategy verdicts, operation outcomes,
uncertainty and experimental supervision remain separate dimensions.

## Retained-reference candidate: Partial

```powershell
node --test tests/data-owner-lifetime-qualification.test.mjs
# Use the UUID printed by that successful current-source baseline packet.
$ownerPriorRegression = $env:RECLAIM_OWNER_WP1_REGRESSION
try {
  $env:RECLAIM_OWNER_WP1_REGRESSION = '<successful WP1 run UUID>'
  node --test tests/data-owner-reference-qualification.test.mjs
} finally {
  $env:RECLAIM_OWNER_WP1_REGRESSION = $ownerPriorRegression
}
```

The reference candidate intentionally skips without an explicit current baseline
receipt. It verifies that packet's source hashes and terminal evidence before
starting any actor. The same environment value includes the candidate in a full
`npm test` run; it does not bypass a failed or stale baseline.

The candidate creates an exclusive lease-file open and duplicates that same native
object into the already contained, suspended helper, writer and mutator. Each
actor's reference is installed and recorded before resume. The controller closes
its initial reference after verified handoff, preventing an observer-held lease
from making the result vacuously busy. The actors retain references through actual
state publication and the selected disposable mutation. No reference or native
handle is accepted through HTTP.

In the measured helper-loss schedule, the real helper dies while the writer and
mutator remain held. B's independent exclusive open is refused while A's references
remain. Actual A publication and mutation then finish; original A actor exits are
observed before B acquires the physical lease. An independent observer checks
lease exclusion, state bytes and mutation. A second schedule attempts physical
parent-directory replacement. Native access refusal prevents that attempted
rename and the observed directory identity stays unchanged. This does not prove
all ancestor, junction or alias replacement paths safe.

The verdict is **Partial**, with no qualified production scope. Two schedules were
observed; fourteen categories remain explicitly unqualified/not run. They include
Node-parent death with survivors, each worker's failure, canonical aliases,
different ports/entry points, independent directories, abandoned/corrupt/ambiguous
recovery, initialization/listen failure, candidate cancellation/blocked drain,
native-adapter failure and seeded contention. Baseline fault-injection success is
not silently transferred into a candidate qualification claim.

The baseline and candidate compile against the same reviewed stop/obligation
mechanism. The shared changes are the partial-class extension and explicit
expected-helper-exit classification, not a copied cancellation state machine.
The current eight-schedule baseline regression was rerun and passed with exact
source snapshots. Both candidate cases end with all eleven original actors exited,
Job counts zero and an unchanged independent outside sentinel. Exact host/runtime,
physical root/lease identities, source/helper hashes and QPC evidence remain in
the private packet. Other host/filesystem lanes are unsupported.

The smallest next experiment must bind or fence publication to retained physical
directory/ancestor identities, or use an exclusive broker that cannot follow a
replaced textual path. Prove an actual junction/ancestor alias replacement schedule
with independent bytes and authority observations before extending lifetime,
entry-point or recovery coverage. A reference to an old physical lease does not
alone establish where a future text-path write will land.

[qualification.json](data-owner-lifetime/qualification.json) binds the historical
experiment source commit, helper/source identities, two observations and complete
required-case matrix. [ownership-contract.json](data-owner-lifetime/ownership-contract.json)
is a proposal with no enabled scopes or production adapter. Historical baseline
and regression inputs stay bound to their exact snapshots; later HTTP changes do
not retroactively rewrite that evidence.

## Adoption gate

Partial or Invalidated results keep the production ownership build gated. Unknown,
abandoned or corrupt recovery evidence preserves existing state for explicit
recovery; it does not authorize reset, stale-PID lock stealing or automatic retry.
The proposal requires opaque ownership and a tracked-operation registry in trusted
server code, with no raw native handles supplied through HTTP. The production
application still has its original per-instance persistence behavior; F03 remains
open. No state-store lock, backup/recovery mechanism, persistence migration or
cleanup authority is shipped by this fixture-only spike.
