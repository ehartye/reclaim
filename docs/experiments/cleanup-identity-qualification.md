# Cleanup identity qualification

This fixture-only experiment evaluates permanent deletion bound to previewed
filesystem identities. It does not enable a production deletion adapter. The
current JavaScript path-check-then-unlink strategy is a known unsafe baseline.
A successful baseline regression means that failure reproduced, not that cleanup
is safe. Native generated-file deletion and unforced Git worktree removal require
separate verdicts. DDC, Zen and guided commands are outside both lanes.

## WP-1: threat model and fixture contract

The attacker may replace a target or ancestor after verification, mutate an
existing descendant, create a new descendant, change policy generation, introduce
links/streams or keep conflicting handles open. Verification must bind the actual
object used by the destructive operation, including ancestor traversal and final
directory removal. A path string or a successful earlier fingerprint comparison
does not establish that binding.

`tests/fixtures/cleanup-identity/manifest.json` defines the lanes, resource limits,
boundary schedule and required case inventory. No row is qualified by listing a
case. Later packages must classify each case with actual evidence or an explicit
unresolved/unsupported reason. The initial scope is an unprivileged Windows host
on its local NTFS fixture volume; other hosts and filesystems remain unsupported.

The boundary schedule covers before/after root, ancestor and entry opens,
identity and policy checks, file disposition and directory removal. Native work
must exercise deterministic barriers with a real external actor as well as a
seeded stress pass. Relevant entry identities include volume/file IDs, type,
link/stream state, parent identity and policy generation. Reuse/replacement of an
ID cannot be treated as continuity without an adequate retained-object proof.

The case inventory includes hardlinks, alternate streams, case sensitivity,
Unicode and long paths, changed/new descendants, tracked/source/protected content,
named exclusions, policy changes, conflicting handles and all cancellation,
failure and resource boundaries. Git additionally requires registration, branch,
ignored-data and unknown-data observations. Generated success cannot qualify Git.

### Read-only contract check

```powershell
node tests/fixtures/cleanup-identity/check-manifest.mjs
```

This command validates the manifest without creating a fixture or writing product
state. It checks fixed relative roles, the lane separation, native boundary pairs
and the established limits: 250,000 entries, 512 retained handles, a 60-second
operation budget and a 5-second drain watchdog.

### Disposable current-engine regression

```powershell
node tests/fixtures/cleanup-identity/current-engine-regression.mjs
```

The command accepts no root, target or other arguments. It creates a unique
`reclaim-cleanup-identity-` directory beneath the OS temporary directory, checks
its canonical containment, and stores exact private receipts under the ignored
`review/cleanup-identity/` directory. All inputs are synthetic. It does not start
an HTTP server or access an existing service, report, project or cache.

The selected `project/dist/payload` and the unselected
`outside-preview/payload` initially contain distinct bytes. After the current
engine completes its final file/path checks, an injected in-process interleaving
renames `dist` to `original-dist`, replaces `dist` with a junction to the synthetic
outside-preview tree, then allows the original unlink call to proceed. This is
the archived audit schedule. It is not a real external-process race and cannot
qualify any native strategy.

The observer reads lstat identities and SHA-256 hashes independently from the
engine receipt. Expected evidence distinguishes the failure precisely:

- The outside-preview payload disappears.
- The previewed payload survives at `original-dist` with its original identity and hash.
- The engine records `started`, then `partial`, with one deleted file and a link/junction error.
- The strategy verdict is **Invalidated**, separately from the operation's `partial` status.

The fixture records a monotonic trace, exact operation records, before/after
observations, source hashes, artifact byte lengths and artifact hashes. A failed
assertion retains those observations. Teardown requires a settled operation,
`running=false`, the unchanged owned-root identity and canonical containment. It
unlinks the fixture junction before recursive removal. If operation/helper
completion is uncertain, the harness retains the fixture and reports that fact.
No automatic retry or successor mutator starts.

## Gates for subsequent packages

WP-1 establishes only a reproducible threat and observation contract. WP-2 must
provide an isolated native generated-file strategy and evidence-backed case
verdicts; WP-3 evaluates unforced Git independently. Every package requires fresh
review before dependent work consumes it.

Any native mutator must be placed in an explicitly owned native process container
before it can mutate the fixture. On missed drain watchdog, its strategy becomes
Invalidated and its operation receipt records interruption separately. The harness
must retain supervision, request cancellation, terminate only its verified owned
tree through that container, and independently observe every member exited before
releasing relevant handles, removing fixtures or starting another mutator. Unknown
exit never becomes a successful drain claim. Cancellation, unsupported state or
resource exhaustion must not fall back to path-based JavaScript deletion or
forced Git removal.

The final contract will use opaque server proof IDs, expected root/entry
identities, policy generation, fixed limits, cancellation and structured
complete/refused/partial/interrupted results. HTTP must not accept arbitrary
execution paths or native flags. Production support remains gated until the
exact lane passes all required cases and independent review.

## WP-2: generated-file native primitive

**Verdict: Invalidated. Production enabled: false.** The blocked-cancellation
negative fixture missed the required five-second drain deadline. The operation
was interrupted and the owned Job was terminated and observed drained; eventual
exit does not repair that qualification failure. The candidate stops at this
first demonstrated violation. Earlier eleven-case Partial receipts remain
separate, unchanged evidence. The isolated prototype exercises one synthetic
selected leaf and its containing directory. It is not a recursive executor,
policy adapter or qualification of the existing production executor.
The machine-readable generated matrix and exact receipts are emitted beneath
ignored `review/cleanup-identity/native-<run-id>/`. A passing assertion suite means
the observations and failure classification matched the experiment; it is not a
Validated lane. The green negative fixture asserts **Invalidated**, not safety.

```powershell
node --test tests/cleanup-identity-qualification.test.mjs
```

The existing Windows C# compiler builds the fixture source into that private
receipt directory. The source accepts only fixed fixture roles/cases beneath a
checked, uniquely named temporary root. It refuses reparse ancestors and checks
the local NTFS filesystem before launching a mutator. The supervisor creates a
named Windows Job with kill-on-close only after proving it is newly created.
`ERROR_ALREADY_EXISTS` is refused before any limit change, spawn or termination;
only the returned reference is closed. The supervisor creates the worker suspended, assigns and
verifies Job membership, then resumes it. Every mutator independently verifies
membership in that exact Job before operating. Children inherit the Job; there
are no breakaway flags. The supervisor retains its original process handle and
queries Job accounting separately from primary-process exit. A failed suspended
launch is terminated and waited through that original handle before release.
The collision fixture retains a live original member in its own pre-existing
container, compares the actual before/after member lists/counts and limit flags,
and verifies that the original member remains alive after refusal. It does not
assume a Job contains only one process. That fixture's owner then releases and
independently observes all members exited.

The worker retains ancestor handles opened without delete sharing, and opens the
selected directory with DELETE access and read/write sharing. Its selected leaf
uses DELETE/read-attributes access and read sharing, excluding write/delete
sharing. Handles carry volume/file IDs and metadata observations; the leaf's
file ID must match the prepared synthetic fixture identity. Hardlinked entries
and alternate streams are refused. Disposition is issued against the retained
handle with `SetFileInformationByHandle(FileDispositionInfo)`, then that handle
is closed. No unlink/rmdir or forced fallback is used by the prototype.

The held handles explain the observed native refusal of rename and write-open
attempts; native access-denied and sharing-violation results remain recorded
separately. Directory handles do not freeze child creation. The late-child case
therefore deletes only the selected leaf, preserves the late child, and records
partial work when nonempty-directory disposition fails. That is an observed
partial operation, not permission to remove the late object.

| Fixed native case | Observed operation | Qualification limit |
| --- | --- | --- |
| Ordinary selected leaf | Complete handle disposition | One leaf and one directory only |
| External target rename | Rename refused; selected leaf removed | One retained-handle boundary only |
| External project-ancestor rename | Rename refused; selected leaf removed | Higher ancestry and other boundaries unresolved |
| External selected-leaf write-open | Write-open refused; selected leaf removed | No writable-map or alternate open-mode proof |
| Late-created child | Partial; selected leaf removed, late child retained | No complete recursive preview strategy |
| Hardlinked leaf | Refused before disposition | One two-link entry |
| Alternate stream | Refused before disposition | One named stream |
| Existing external writer handle | Refused before disposition | One conflicting sharing mode |
| Explicit cancellation | Interrupted before disposition | One cooperative cancellation barrier |
| Injected worker exit | Interrupted; original handle signaled and Job active=0 | Supervisor/parent death remains unresolved |
| Unicode path names/content | Complete | Long paths remain unresolved |
| Existing named Job | Refused before policy/spawn/termination; existing members and limits unchanged | Collision fixture only |
| Blocked cancellation | Five-second drain missed; strategy Invalidated; operation interrupted; owned termination and strict drain observed | Candidate stopped; no successor mutator |

Every observed outside-preview sentinel retained its identity and exact bytes.
The Node observer checks those hashes independently from the native operation
receipt after observing primary exit and zero active Job members. The final run
contains exact source snapshots, source/helper hashes, native identities,
access/sharing flags, errors, QPC traces with their common frequency, operation
status and byte/hash inventory. An earlier harness assertion expected only a
sharing violation for ancestor rename; the host returned access denied. That
was corrected to recognize the actual native refusal and was not a deletion
safety violation. The final receipts identify the rerun explicitly.

The supervisor enforces a maximum 60-second operation window. The first explicit
cancellation, primary-exit stop or operation-budget stop starts one monotonic
5-second drain deadline immediately. A missed watchdog marks
the strategy invalidated separately from operation interruption, terminates only
the owned Job and retains supervision until both original-process exit and zero
active members are independently established. The Invalidated/interrupted pending
receipt is durable before termination; the final receipt records strict drain.
JavaScript captures nonzero native exits as data, preserves exact native receipts,
observes actual sentinel/payload state and finalizes the matrix and byte/hash
inventory even on failure. A dedicated native finally receipt can establish safe
teardown after an unexpected error without claiming a successful operation.
Unknown exit retains the fixture and prohibits a successor mutator.
The retained-object handle guard reserves space for target and leaf within 512
handles. Exhaustion and operation-budget schedules remain **unqualified**, as
does the 250,000-entry
inspection ceiling and general recursive inventory: this prototype inspects one
selected leaf, not 250,000 entries.

The required matrix also marks case-sensitive directories, long paths, file-ID
reuse/replacement, tracked/source/protected content, exclusions, policy-generation
changes, unsupported volume/reparse fault schedules, complete before/after native
boundary schedules, parent/supervisor death, operation/resource exhaustion and
seeded contention stress as unresolved. Listing a case or enforcing a source-code
guard does not establish its qualification. Outside-preview data remained unchanged
in the measured cases, but the blocked-cancel drain violation requires Invalidated.

The smallest next experiment must replace the non-cooperative admitted-operation
contract with an enforceable bounded drain/fence contract, then prove the
first-cancel deadline with a held pre-disposition actor. Only after settling that
contract should a two-leaf native preview test before-entry-open identity
replacement and retained-object resource limits. Keep the generated lane disabled
in any proposed production contract; do not promote this invalidated candidate.
Git has the separate candidate verdict described below; generated observations do
not qualify it.

API grounding uses Microsoft's [CreateFileW sharing contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[handle disposition API](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle),
[disposition structure](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info)
and [Job accounting API](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject).
[Named Job creation](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw)
and the [Job member-list layout](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list)
ground the collision check.
These establish primitives; they do not establish recursive containment or policy safety.

The machine-readable report pins the historical rejection inputs to their source
commit. A later integration correction makes the collision fixture poll all owned
members to zero after the original member exits, rather than assert immediate
zero while runtime children may still be draining. It uses one first-release
deadline and a controlled held member to exercise that interval. The earlier
packets remain immutable; this harness correction does not qualify a deletion lane.

## WP-3: unforced Git lane and disabled adapter proposal

**Git candidate verdict: Invalidated. Production enabled: false.** The ordinary
unforced-command observation remains Partial. A separate owned descendant-survival
schedule demonstrates that worker-owned proof handles can end while an admitted
descendant remains capable of DELETE access. That strategy is discarded. The
Git-only sources never resume or promote the generated candidate. A clean
registered linked worktree contains tracked fixture files
only. Its branch and an additional preserving reference point to the fixture
commit. Synthetic generated and unknown ignored files remain in the unselected
main repository, with independent outside-preview sentinel bytes. This separates
clean-target compatibility from content-policy blockers.

```powershell
node --test tests/cleanup-git-qualification.test.mjs
```

All Git setup and removal commands run inside the newly owned native Job. The
Git child is created suspended, exact Job membership is checked, and only an
explicit stdin/stdout/stderr handle list is inherited before resume. It receives
a fresh allowlisted environment with private HOME, profile/config and temporary
directories; global/system configuration, system attributes, prompts, hooks,
signing, filesystem monitoring and optional index updates are disabled or scoped
to the synthetic fixture. No repository hook, owner configuration or network
operation is selected. The command log retains actual arguments and outputs.

The worker records empty selected-worktree status before acquiring the required
retained target and every selected-entry handle. It retains all those handles
through the single unforced `git worktree remove` call. An independent observer
reads the prepared file identities and bytes at a closed-receipt barrier before
allowing removal. Native delete-access probing returns sharing refusal 32 while
the target is retained. In the ordinary scenario, Git returns 128 while its internal status operation
reports that it must run in a worktree. The evidence does not identify the exact
internal open/sharing failure, so it establishes neither a qualified operator nor
a causal Invalidated claim about that Git command. That observation remains
Partial; no weaker protection or forced retry is attempted. It does not override
the separate lifetime counterexample.

Git registration and preserving branch refs remain unchanged in all three fixed
scenarios, independently checked from their filesystem bytes. Selected
files, unselected ignored/unknown fixture data and the outside sentinel retain
their observed identities and bytes. The observer verifies original worker exit
and zero active Job members before identity-checked temporary-fixture teardown.
The operation and supervision receipts, exact source snapshots, executable hash,
Git binary identity, command outputs and artifact byte/hash inventory are private
under ignored `review/cleanup-identity/git-<run-id>/`.

The corrected harness latches the earliest native QPC timestamp from explicit
observer cancellation, internal command-budget/error stops, primary exit or the
overall operation budget. Each Git command checks stopped admissions before
creation and before resuming its suspended child. The cooperative observer-cancel
scenario waits for the supervisor's first-stop acknowledgement, admits no later
Git command and drains within five seconds.

The negative scenario uses explicitly labeled native launcher/descendant
stand-ins for an admitted Git process tree. The same command-wait function uses a
fixed injected 200 ms budget, publishing its shared QPC stop request before
terminating/waiting for the original launcher. The original worker then exits and
its local proof handles close while the already-contained descendant remains
alive. Only after the original worker handle signals does the supervisor allow
that existing descendant to try a DELETE-access open of the same target. The open
succeeds, demonstrating lost protection. It issues no disposition, deletion,
rename or another Git removal. The violation is durably classified
Invalidated/interrupted and no successor mutator is admitted. The negative
descendant deliberately does not drain; the five-second deadline from the
original internal stop is missed, the owned Job is terminated, and all exits are
independently observed before teardown. Eventual drain does not repair either
candidate failure. This exercises the shared timeout/error path, not every real
Git descendant or a full 20-second Git command timeout.

The harness retains its owned container and supervision throughout. It records a
counterexample to worker-owned proof lifetime; it does not claim that design was
repaired. A new supervisor/broker design retaining proof authority until every
admitted member is terminal needs a separate experiment. Historical Partial
receipts remain unchanged and separate. Any failed scenario, timeout or unknown
authority prevents subsequent scenarios.

The full matrix classifies the ordinary compatibility observation as Partial and
the measured lifetime/drain counterexample as Invalidated. Selected ignored/unknown contents, changes at every native boundary,
registration races, branch changes, untested cancellation/death schedules, resource
exhaustion, alternate filesystems and the remaining required cases are unresolved.
Unselected ignored data staying unchanged does not qualify deletion of ignored
data within a selected target. A new operator/ownership design or a narrowly
observed Git open-failure trace is needed before further race qualification;
retained protections must not be weakened to obtain a successful deletion. This
worker-owned candidate cannot be promoted regardless of the unresolved ordinary
Git-open cause.

[qualification.json](cleanup-identity/qualification.json) records both exact
operator lanes and their evidence identities. The overall candidate set is
Invalidated: generated missed its drain deadline and the Git candidate failed its
proof lifetime/drain requirements. The ordinary Git command observation remains
separately Partial. [adapter-contract.json](cleanup-identity/adapter-contract.json)
is a proposal with no enabled lanes and no production implementation. It names
opaque server proofs, expected identities, policy generation, fixed limits,
cancellation/drain ordering and separate operation/qualification dimensions. HTTP
must not accept arbitrary execution paths, raw native flags or force options.
No production server policy or cleanup capability changes in this spike.
