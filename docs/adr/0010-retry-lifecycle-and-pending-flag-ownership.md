---
status: accepted
date: 2026-09-24
---

# Retry Lifecycle and Pending-Flag Ownership

Mahalla Ovozi lets a District Hokim or Product Owner re-execute a failed operational operation through `retry-service.ts`. The system must answer two questions unambiguously: **when is a retry still in flight?** and **who owns the flag that says so?**

Today the answer is inconsistent, and a real defect follows from it. This ADR fixes the semantics. It changes **no code**; the defect it names is recorded here so the fix has an agreed contract to implement against.

## Context — the defect this ADR exists to resolve

`retry-service.ts` uses `operational_issues.metadata.pendingRetry` as the single signal that a retry is in flight:

- `retry-service.ts:149` **rejects a second retry** while `issue.metadata?.pendingRetry === true`, throwing `DuplicateRetryInProgressError` with code `DUPLICATE_RETRY_IN_PROGRESS`.
- `retry-service.ts:207` **sets** `pendingRetry: true` when a retry is dispatched.
- `retry-service.ts:167-171` dispatches to pg-boss with `retryLimit: 3`, `retryDelay: 5`, `retryBackoff: true`. **The job may therefore execute up to three more times after the initial attempt.**
- `retry-service.ts:352-368` `clearPendingRetryFlag` is the flag **only** writer of `false`. Its own docstring says it runs "when the retry job finishes".

The defect is in **who calls** `clearPendingRetryFlag`. Its only production caller is `topic-assignment-coordinator.ts:780`, inside a `finally` block at `:778` that wraps a body ending in `throw err` at `:777`:

```js
    throw err;
  } finally {
    if (input.issueId) {
      await clearPendingRetryFlag(db, input.issueId);
    }
  }
```

**The `finally` runs on the failure path.** So on the exact path the flag was designed to describe — a retry that is failing and about to be retried again by pg-boss — the flag is cleared. Three consequences follow, in increasing severity:

1. The flag no longer means "a retry is in flight". It means "a retry reached a terminal outcome, or failed once".
2. The `DuplicateRetryInProgressError` guard at `:149` is re-opened **while pg-boss is still retrying**. An operator can dispatch a second, concurrent retry of the same operation.
3. The operator-facing "retrying" signal clears while the operation is still failing — the failure is silently misreported to a human.

The `issueId` that reaches the coordinator is populated by `retry-evaluator.ts:212,226` as `payload: { ...issue.metadata, issueId: issue.id }`, so this path is live for retried assignment jobs, not theoretical.

## Decision

**The `pendingRetry` flag describes the retry lifecycle, not a single execution attempt. It is set when a retry is dispatched and cleared only when the retry reaches a terminal outcome.**

Three normative rules follow.

### Rule 1 — The flag is cleared by the last attempt, not the first failure

A job dispatched with `retryLimit: 3` has up to four executions: the initial attempt plus three retries. The flag must survive every non-terminal failure and be cleared exactly once, when the operation either succeeds or exhausts its retry budget.

Clearing it in a `finally` block that runs on the failure path is **non-conforming**, because a `finally` cannot distinguish "this attempt failed and another is coming" from "the operation is finished".

### Rule 2 — pg-boss terminality is the authority, not the coordinator

The job payload reaches a coordinator that knows only whether *its own* execution threw. pg-boss knows whether *the job* is finished. Therefore the clear must be driven by the pg-boss lifecycle — a completion handler, or an attempt-count check against `retryLimit` — not by the coordinator `finally`.

A coordinator may report its own attempt outcome; it may not conclude the retry is over.

### Rule 3 — The duplicate-retry guard must not depend on the flag alone

`retry-service.ts:149` currently uses the flag as its **only** in-flight check. Even with Rules 1 and 2 correct, a flag is a non-atomic read-modify-write across two concurrent requests. The guard should also use the pg-boss singleton key already present in the dispatch (`singletonKey: jobSpec.singletonKey`, `singletonSeconds: 300`), which is an atomic deduplication primitive the queue already enforces.

## Considered options

- **Clear the flag only on success (move it out of `finally`).** Rejected as incomplete: a retry that exhausts `retryLimit: 3` never succeeds, so the flag would stay `true` forever and permanently wedge the issue against any future retry. Correct terminality includes exhaustion, which the coordinator cannot see.
- **Leave the flag set for the whole pg-boss retry window and let the operator see "retrying" until the queue drains.** Accepted as the intent — this is Rule 1. It is the option the current code was trying to implement.
- **Drop `pendingRetry` and derive the state from pg-boss at read time.** Rejected for now: it is a larger change, it couples the issues read path to the queue, and `metadata.retryCount` / `lastRetryAt` / `retryTrackingId` are already persisted alongside the flag. Worth revisiting if the flag proves hard to keep honest.

## Consequences

- **The coordinator loses a responsibility it should not have had.** `topic-assignment-coordinator.ts:778-782` must stop clearing the flag. This is the concrete code change this ADR authorises in principle but does not perform.
- **`clearPendingRetryFlag` acquires a stricter contract.** Its docstring already says "when the retry job finishes"; Rule 2 makes that literal, and its callers become responsible for establishing terminality.
- **The operator-facing signal becomes trustworthy.** `pendingRetry: true` will mean a retry is genuinely in flight, which is what `retry-service.ts:149` and the UI both assume today.
- **A behavioural test becomes possible and is the acceptance criterion.** Dispatch a retry whose first attempt fails, assert `pendingRetry` is **still `true`** after that failure, and assert it becomes `false` only after the final attempt. Today that test fails at the first assertion.

## Status and scope

This ADR was requested by the user as **semantics only, no code change** (ruling `a1_ruling = 'ADR only - define semantics, no code change'`). It records the defect and the agreed contract. **It does not authorise or describe an implementation.** The fix, when funded, is a separate change with its own test.


