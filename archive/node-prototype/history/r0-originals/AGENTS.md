# FlowCredit-Harness contributor constraints

- Keep changes small. Preserve Evidence Authority, host-owned permissions and budgets, durable identities, explicit receipt reconciliation and conservative unknown handling.
- Do not modify accepted tests to manufacture PASS. Preserve failing run evidence. Baseline digests require an explicit compatibility/provenance decision before changing inherited Runtime or tests.
- Use `node scripts/verify.mjs <group>` during focused work; use the full command and a clean local clone for acceptance. No dependencies are required. Never test in frozen experiment originals.
- Only reviewed code, contracts, synthetic examples and sanitized summaries belong in Git. Raw trajectories and local state stay in protected ignored roots. Review the publication inventory, index and reachable history before committing.
- Do not read real model keys, call paid providers, train/download models, publish, push, merge or deploy without explicit authorization. Local R0 commits do not authorize publication.
- Teacher collection, dataset construction and Student training are future boundaries described in `docs/research-foundation.md`, not implemented features.
- Keep the known Finch concurrent failure visible; it is outside this repository's inherited minimal finance dependency closure.
