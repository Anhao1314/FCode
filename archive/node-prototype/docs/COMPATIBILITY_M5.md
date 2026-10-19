# M5 compatibility decision: recovering store and observable tools

Status: additive. No inherited file changes, no inherited contract changes, no research artifact re-baselined.

## Why this exists

Two defects blocked the next step, and both were inherited rather than new.

**1. An unattested history entry was fatal, not recoverable.**
`DurableTaskStore.commit()` publishes in the order history → witness → checkpoint. A crash between the first two left the task permanently unreadable: `anchored()` raised `M1_HISTORY_AHEAD`, and `recoverLatest()` raised it again because recovery itself starts from `anchored()`. The history entry is immutable, so it could not be overwritten, and the documented position was simply to stay blocked.

That is unacceptable before any batch run. A 100-task experiment that crashes once loses a task silently and cannot say which one, which contaminates the only product this project actually has: a trustworthy dataset.

**2. Every load replayed the entire history.**
`load()` called `anchored()`, which re-read and re-HMAC'd every entry from sequence 0. `save()` loaded once and `commit()` anchored again, so a task with N checkpoints cost O(N²) reads. This was survivable for one task and fatal for a batch.

**3. The model could not see a single fact value.**
`project('evidence.read')` returned `factIds` only. `contextFor()` compressed observations further, to `factCount`. A model could count facts but could not read one, so no task built on this harness could ever require reading.

## What changed

Three new modules. Nothing inherited is edited.

| File | Kind | Responsibility |
| --- | --- | --- |
| `packages/native-agent/src/recovery-store.mjs` | new | `RecoveringDurableTaskStore extends DurableTaskStore`: `repairHistory()`, `recoverLatest()` that repairs first, and a witness-keyed verified cache |
| `packages/native-agent/src/observable-tools.mjs` | new | `createObservableEvidenceTools`: the accepted tools plus a compact `facts` projection |
| `packages/native-agent/src/observable-runtime.mjs` | new | assembly only: recovering store + observable tools + accepted model API and harness |
| `scripts/verify-m5.mjs` | new | independent gate; also proves the 92 inherited modules are byte-identical |
| `research/m5/test/*.test.mjs` | new | 10 offline tests |

## The repair contract

The witness remains the only source of truth. History entries beyond the witness were never attested, so they are neither trusted nor deleted:

1. `repairHistory()` first tries a normal `anchored()`. If it succeeds, nothing is repaired.
2. Only `M1_HISTORY_AHEAD` is repairable. A gap **below** the witness means attested bytes are missing; that is data loss and still fails.
3. Orphan entries are moved byte-for-byte into `quarantine/<id>/` and their hashes recorded.
4. The repair is sealed into `recovery-evidence/` as a signed record, so the act of repairing is itself auditable.
5. `load()` never repairs. Only an explicit `recoverLatest()` may move bytes.

## The cache contract

The cache is keyed by the witness bytes and is deliberately **process-local**:

- the witness is re-read and re-verified on every call, so a changed anchor always misses;
- `commit()` advances the cache, so a checkpoint costs two reads instead of N;
- a restart starts empty and re-verifies the whole chain.

A process that stays alive while someone rewrites history it already verified will not notice. That attacker already controls the store root and the signing key, which the accepted threat model excludes. The trade is stated here rather than hidden.

## The projection contract

`evidence.read` now returns `facts` alongside the unchanged `factIds`. The accepted shape is preserved, so `trajectory-export`, T1's dataset builder and every frozen research module keep working untouched.

Each fact carries `id, metric, value, unit, period, scope, basis, status, sourceIds`. It deliberately excludes `authority`, `binding`, `observationDecisions` and `alternatives`: those are Runtime audit material, not model reasoning material, and they made a single fact roughly 2 KB. The whole nine-fact observation stays under 8 KB.

`tools.version` remains the accepted `flowcredit.native-tools/experimental-v1`, because the tool contract — names, effects, empty arguments, gates — is unchanged. The differing payload is declared separately as `projection: flowcredit.observation-projection/m5-v1` on the factory and on every catalog entry, so a trajectory can be attributed to a projection without reinterpreting an inherited version string.

## What this does not do

- It does not change `M4`'s loop context. `contextFor()` still summarizes to `factCount`, so an M4 loop still cannot read a fact. That is the next increment and needs its own policy-version decision.
- It does not parameterize tools. `arguments` must still be `{}`.
- It does not make the harness batch-capable, configurable or sandboxed.
- It does not re-baseline T1, T2-A or T2-B, and it does not touch their claims.

## Verification

```sh
node scripts/verify-m5.mjs          # 10 M5 tests + inherited-module identity
node scripts/verify-m5.mjs all      # additionally the unchanged 291-test R0 gate
```

The gate fails if any of the 92 modules pinned by `research/t2-b/inherited-hashes.json` changes by one byte.
