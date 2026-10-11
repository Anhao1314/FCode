# Development and verification

Use Node.js 24 on macOS or Linux and Git. `.node-version` pins the supported major, not a bit-identical binary. Each run records the actual Node version and platform. Windows is unsupported by this validation profile because permissions, directory synchronization and SIGKILL semantics are part of the inherited tests. No dependency installation or npm is required.

```sh
node scripts/verify.mjs
```

The same command runs locally and in CI. It audits the public file set and T0 hashes, copies only reviewed source files into a fresh protected local directory, and explicitly enumerates all tests with Node's built-in test runner. File-level concurrency is one; the original subprocess and concurrency tests still execute their own real concurrent operations. No test deadline, assertion or acceptance threshold is changed. A full run requires 280 inherited tests plus 11 repository tests, with no skips, cancellations or TODOs.

For a relevant subset, append `repository`, `legacy`, `finance`, `deepseek` or `trajectory`. A subset is not full acceptance. The existing npm aliases remain available when npm is installed. Test output and generated raw evidence are preserved under unique run directories inside `validation/r0/` and `work/r0-runs/`; the frozen tests' fixed-name outputs are confined to that run's private copy. Failed runs are retained, never replaced by a retry. Do not run tests directly in frozen historical originals.

The test child receives only PATH, test mode, disabled backend, local temporary paths, locale and timezone. It does not inherit API keys, `NODE_OPTIONS`, HOME or cloud credentials. Existing live-boundary tests replace transport with injected HTTP and synthetic credentials. This is not an OS network sandbox; a hostile code change could create network access and requires review. CI passes no model secrets.

`publication-files.json` is the explicitly reviewed public file inventory. Verification checks working files, actual staged bytes and every reachable Git revision. It rejects private paths, non-regular files, common credential/state patterns, unexpected dependencies and escaping/missing imports. A changed staged file must match its working copy. This bounded scanner supplements human review; it is not proof that arbitrary sensitive prose is absent.

`history/t0-source-hashes.json` commits the accepted T0 files. The three repository metadata changes have original copies under `history/t0-documents/`; all other accepted files are checked in place. Future intentional Runtime changes require a reviewed compatibility decision, explicit provenance update and appropriate regression evidence. Do not regenerate the baseline merely to make a failing check pass.

CI uses ephemeral GitHub-hosted Ubuntu and macOS workers, Node 24, immutable action revisions, read-only repository permissions and disabled credential persistence. It runs the full verification command and a final tracked-file cleanliness check. It never uploads raw logs, state or caches, requests model secrets, publishes packages or deploys. Test results in local R0 evidence prove the command; an actual hosted CI run remains pending until the owner authorizes publication.

CI choices follow [GitHub's security guidance](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions), the official [checkout](https://github.com/actions/checkout) and [setup-node](https://github.com/actions/setup-node) contracts. File-level scheduling uses the documented [Node test concurrency option](https://nodejs.org/api/cli.html#--test-concurrency).

Before a separately authorized push: review the entire candidate history, run full verification from a clean local clone, inspect the exact changed file set and license scope, confirm there are no raw data files, and obtain owner authorization for the exact branch/commit. CI configuration is not branch protection; repository rules must be configured by the owner after publication.
