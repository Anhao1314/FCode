# Repository architecture

R0 establishes one local Git repository from the accepted T0 candidate. It adds repository tooling and documentation; all 76 inherited JavaScript modules, tests and helpers remain byte-identical. There is one package, no build step, no external runtime or test dependency, and no additional agent framework.

| Boundary | Location | Responsibility |
| --- | --- | --- |
| Host API | `packages/native-agent/src/public-api.mjs` | Creates the existing durable Harness or Loop. Host supplies permissions, route, budgets and transmission authorization. |
| Execution | `durable-harness.mjs`, `loop-harness.mjs`, durable stores | Executes independently validated actions; maintains per-round identities, checkpoints, explicit recovery and termination. |
| Model API | `provider-model-api.mjs`, `provider-adapters.mjs`, `deepseek-*.mjs`, `model-budgets.mjs` | Provider contracts, signed receipts, reservation, concurrency and unknown outcomes. DeepSeek is disabled by default. |
| Evidence and tools | `tools.mjs`, `baseline.mjs`, `vendor/flowcredit-finance/` | The actual inherited read-only Evidence tools, Authority and deterministic calculation dependency closure. |
| Trajectory | `trajectory-*.mjs` | Explicit projection from signed execution, independent quality classification, local provenance and source-authorized structural export. T0 rejects live Teacher sampling. |
| Repository verification | `scripts/`, `test/repository.test.mjs`, `.github/workflows/` | Publication inventory, T0 integrity, dependency closure, isolated offline tests and CI. No execution or model authority. |
| Accepted history | Root protocol documents, `history/`, T0 `reports/ACCEPTANCE.md` | Version boundaries, source/evidence digests and earlier failure summaries. |

The package exports `flowcredit-harness`, `flowcredit-harness/trajectory` and, since M5, `flowcredit-harness/observable`. Internal modules remain implementation details; moving or renaming them adds no value in R0. The existing epoch names M1/M2/M4 in source files identify real compatibility boundaries rather than duplicate frameworks.

Execution and recording remain separate. A model proposes an action; Runtime checks authority, tool schema and Evidence before execution or completion. A Recorder failure cannot change a completed task. A signed locally verified success is an execution label, not a financial factual gold label or demonstrated model research ability.

Unknown model outcomes keep the original reservation and prohibit automatic resend, refund or provider failover. Only explicit reconciliation against a trusted matching receipt can resolve them. Dead-process locks and anchored checkpoints use the existing recovery procedures. The history-before-witness window still fails closed with `M1_HISTORY_AHEAD` on every read; M5 adds an explicit repair in `recovery-store.mjs` that moves unattested entries into `quarantine/` and is reachable only through `recoverLatest()`.

Future boundaries are documented here, with no empty packages or speculative interfaces:

1. **Teacher collection** will consume the host API, explicit paid-call grants and Recorder; it cannot own or bypass Runtime authority.
2. **Dataset construction** will consume reviewed, versioned export candidates with source-specific use rights and independent quality evidence; it cannot silently relabel raw unknowns.
3. **Student training and evaluation** will consume immutable dataset versions with contamination controls; it will not import production credentials, receipts or state stores.

These future components need separate research and approval. No training pipeline, memory system or multi-agent orchestration is included.
