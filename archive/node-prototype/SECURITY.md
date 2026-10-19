# Security and publication boundary

Raw goals, model text, source bodies, capabilities, local signing identities, receipts, checkpoints, trajectory blobs and export approvals belong only in protected local execution roots. `work/` and `validation/` are private and excluded from the reviewed public inventory. Do not force-add them, attach them to public issues, or upload CI artifacts containing them. The public synthetic examples are reviewed structural demonstrations, not a training-data license.

Run `node scripts/verify.mjs repository` to check the current inventory, staged objects, reachable commit trees, baseline and repository safety negative tests. Run the full command before accepting changes. The scanner catches defined paths and patterns; an unknown secret format or sensitive narrative still needs human review. Its manifest and provenance files are ordinary code-review assets, not an external trust anchor against a malicious maintainer.

Host authority, Evidence Authority, model and token/cost grants, signed receipts and the independent completion verifier remain the trust boundaries. Neither model output nor a client request may enlarge them. Unknown outcomes remain reserved and blocked until explicit trusted reconciliation. Do not recover history by deleting failed files, inventing receipts, resetting locks automatically or changing a checkpoint to match a desired outcome.

CI has no model credentials and performs no publication or raw-artifact upload. Repository visibility, branch protection and release permissions remain owner decisions. Do not send credentials or raw financial/trajectory data when reporting a vulnerability; share a minimal synthetic reproduction and arrange a private channel with the repository owner.

The known Finch concurrent failure is tracked in `reports/ACCEPTANCE.md` (T0) and `history/failure-catalog.json`. R0 does not modify Finch or claim that its high-load behavior is repaired.
