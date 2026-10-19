# FlowCredit-Harness contributor constraints

- Keep changes small. Preserve Evidence Authority, host-owned permissions and budgets, durable identities, explicit receipt reconciliation and conservative unknown handling.
- Do not modify accepted tests to manufacture PASS. Preserve failing run evidence. Baseline digests require an explicit compatibility/provenance decision before changing inherited Runtime or tests.
- Use `node scripts/verify.mjs <group>` during focused work; use the full command and a clean local clone for acceptance. No dependencies are required. Never test in frozen experiment originals.
- Only reviewed code, contracts, synthetic examples and sanitized summaries belong in Git. Raw trajectories and local state stay in protected ignored roots. Review the publication inventory, index and reachable history before committing.
- Do not read real model keys, call paid providers, train/download models, publish, push, merge or deploy without explicit authorization. Local R0 commits do not authorize publication.
- T1 is a closed synthetic dataset research experiment under `research/t1/CONTRACT.md`. Its readiness is BLOCKED; it does not authorize real Teacher collection or Student training. Preserve R0's original 291-test gate and all 79 inherited JS/MJS modules; run the additional T1 gate separately.
- Keep the known Finch concurrent failure visible; it is outside this repository's inherited minimal finance dependency closure.

- T2-A is a separate ONE-decision benchmark, not a production Harness extension. Keep all 84 T1 JS/MJS unchanged. Preserve frozen Gold/corpus/policies and audit any engineering repair; never tune labels to scores. Run the additional T2 gate after the unchanged R0/T1 gates. Do not treat authored rule performance as Teacher/Student evidence.
