# Next research: Teacher Training Dataset

The next useful output is a small, explicitly scoped dataset protocol and offline evaluation design, not a Student training run. T0 currently exports structural actions, counts and independently checked execution labels. It omits task/answer text and cannot be treated as a ready-made chat SFT corpus.

| Question | Recommended next experiment / decision |
| --- | --- |
| What should a Student learn? | Define one read-only financial research task family and measurable target behavior. Separate tool-policy learning, factual research, final-answer quality and recovery behavior. |
| What is a valid training record? | Specify the required objective, public rationale/action, observation, source citations, independently verified result and terminal status. Do not require hidden chain-of-thought. Decide which missing fields invalidate each training use. |
| Which labels are trustworthy? | Preserve execution verification separately from factual correctness. Plan independent source checks or adjudication for answer quality. Unknowns and insufficient evidence remain excluded from positives; diagnostic failures must not become preferred answers. |
| Can the data legally and safely be used? | Review source-specific acquisition and training rights, purpose, expiry and deletion obligations before retaining text. Evaluate sensitive-information filtering and scoped pseudonyms; hashes are linkable, not anonymous. |
| How are train and evaluation sets separated? | Split by underlying source/entity/time/task family, not merely row ID. Deduplicate across restarts and collection runs, and check source overlap before publishing evaluation claims. |
| What does Teacher add? | Compare static Plan, current deterministic Mock branches and later separately authorized Teacher decisions under the same tasks, tool access, budgets and independent scoring. Mock success establishes engineering behavior only. |
| What can preference pairs mean? | Compare independently verified alternatives for the same task and source revision; record ties, abstentions and failure causes. Model self-ratings alone cannot select the preferred answer. |
| How can a dataset be reproduced? | Version schema, code commit, data-use approval, source snapshot/revision and export hashes. Keep private lineage behind controlled access; publish only approved manifests and samples. Distinguish unavailable raw text from retained hashes. |

Before real collection, resolve the existing [first-call authorization checklist](../FIRST_REAL_CALL_AUTHORIZATION.md), token/cost uncertainty and paid-call ceilings. T0's offline-only boundary must not be bypassed through an alternative demo. A future paid Teacher experiment needs its own explicit authorization and acceptance criteria; Student training, GPU work and model downloads are separate stages.

No research gain, financial advice quality, legally valid training rights, anonymization, external billing guarantee, power-loss consistency or trained Student capability is claimed by R0.
