# Reliability and explicit advisor controls

Canonical task: https://github.com/CBEPX/cc-plugin-codex/issues/76

Approved scope: review isolation, actionable diagnostics, explicit native advisor policy, bounded telemetry, and live qualification.
Baseline: v1.7.12, fb6c091cb0372fa716fa2d4ff110ff93453a5e61.

## Global Constraints

- Preserve model defaults, user and managed policy, strict MCP restrictions, leases, ownership, and workspace guards.
- Use native Claude advisor support. Add no dependencies or advisor orchestration layer.
- No flag means inheritance. Preserve the originating policy on resume and freeze peer policy for critique and retries.
- Fail closed when protective settings cannot be preserved. Never remove protective flags to retry.
- Use TDD and independent review for each task. The controller runs changed-behavior E2E before commits or PR publication.
- Keep merge, release, and installation separate. Do not change installed plugins or global Claude settings.
- Keep artifacts and execution evidence in task-owned directories. Give each writer a separate worktree and claim.
- Public technical prose uses STE-flavored English. Instructions use Strict mode with technical precision preserved.

TRIZ: measure_first. Model quality and latency need measurements before any performance tradeoff or default change.

## Task 1: Isolate review settings

Owner: Opus 5.5 high. Independent reviewer: Fable 5.1 high.

Apply --setting-sources user to working-tree, branch, adversarial, and stop-review execution. Preserve user and managed policy.
Read original and reviewed project settings as data. Preserve positive deny rules and convert ask rules to denials under dontAsk.
Project hooks, env, allow rules, and automatic instructions must not load. Project instructions can be explicit review data.
Preserve path and source semantics, including linked-worktree primary local settings. Use disallowedTools where equivalent.
Reject malformed files, negated exceptions, and unsupported projection before launch. Require a valid CLI version >=2.1.281.
Cover every review path, rule anchoring, denied operations, startup side effects, capability rejection, and cleanup with tests.

## Task 2: Repair diagnostics and retry behavior

Owner: Sonnet 5.5 high. Independent reviewer: Opus 5.5 high.

Distinguish unauthenticated status, auth probe timeout, spawn/probe failure, and proven organization subscription refusal.
Do not prescribe login for unrelated failures. Report unsupported required CLI capabilities without dropping protective flags.
Forward task text without appended punctuation. A retry after reservation release obtains a new ID.
Keep existing job owner, lease, and workspace protections.
Fix #54: close the exclusive export descriptor if fstat fails. Unlink only when file identity is established.
Qualify #57 with deterministic readiness and retain SIGTERM-ignore and SIGKILL-reaped assertions.
Use regression tests with RED/GREEN evidence, then full tests and applicable integration/E2E.

## Task 3: Add advisor controls across workflows

Owner: Sonnet 5.5 high. Independent reviewer: Fable 5.1 high.

Support --advisor inherit|off|<alias-or-id> for task/rescue, review/adversarial, design/research.
Support stopReviewAdvisor through setup --stop-review-advisor.
No argument means inherit. Off sets CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 only in the child environment.
Explicit models use native --advisor. Preserve any pre-existing global disable.
Resume without a flag preserves the originating policy. Freeze peer policy across memo, critique, and retry.
Read old records without migration. Qualify explicit advisor against CLI >=2.1.293 without relying on help output.
Do not silently retry without an explicitly requested advisor.
Cover CLI, config, request persistence, workers, resume, peer manifests, and stop-review independently.

## Task 4: Separate advisor telemetry

Owner: Opus 5.5 high. Independent reviewer: Fable 5.1 high.

Record bounded requested policy/model, observed advisor call count, evidenced advisor model, and diagnostic status.
Do not persist advice text. Separate server events from ordinary toolUses, primary finalModel, and modelFallbacks.
Zero observed calls means not observed. It does not establish disabled status.
Test actual supported stream shapes, duplicate event handling, malformed events, terminal failures, and primary model attribution.

## Task 5: Qualify live behavior and compare models

Owner: Codex integration. Fable 5.1 high reviews final behavior. Haiku 5.5 medium checks evidence completeness read-only.

Add the opt-in live gate described in #27. Keep credentials out of unit tests and reports.
Verify exact plugin revision, actual model, native Draft07 output, frozen manifests, citations, and exact Brave tools.
Require brave_web_search and brave_llm_context under the brave-search MCP namespace. Reject lookalike tool names.
Verify peer work leaves no workspace entries changed. Do not impose that rule on ordinary task hooks.
Keep unsupported native Windows peer execution fail-closed.
Compare seven configurations: Opus 5.5, Sonnet 5.5, and Haiku 5.5 each with advisor off and Fable 5.1 advisor, plus standalone Fable 5.1 off.
Run the same diagnosis, known-defect review, and small disposable fix for each configuration. Set primary effort high.
Start with 21 calls. Repeat only ambiguous outcomes. Record correctness, misses, false positives, duration, available usage, and observed advisor calls.
Verify Sonnet and Haiku actual models before assigning work. Do not infer a default-model change from one pass.
Run lint, both typechecks, unit, integration, E2E, and required mutation gates without reducing thresholds.

Defer #38 and #39 provenance work. Preserve the #56 decision inventory. Exclude PR #36 and unrelated defaults.

## Execution record

Local source commits:

| Task | Commit | Result |
|---|---|---|
| Review settings isolation | `dd9e65af3ac432d38c517e6e78ae71ecf13280d8` | Implemented and independently reviewed |
| Diagnostics and cleanup | `f41e66cfbbed88a88e8ebee4fdf1144317140c96` | Implemented and independently reviewed |
| Native advisor policy | `3d4046c37b9b3d19934bda9f025ba65096014f4d` | Implemented and independently reviewed |
| Bounded advisor telemetry | `e4c791513aff6d879cd5ae461daebcdd238f5f71` | Implemented and Fable approved |
| Native peer gate | `096cfd065a8dee7bce0a4c43c2bcead8b66d54f4` | Implemented and Fable approved |

The combined `npm run check` passed: 1279 unit tests, 144 integration tests, and 33 E2E tests. Lint and both typechecks passed.
The controller also ran eight independent Task 4 probes. The gate tests include the actual telemetry parser and the sanitized native fixture.

Required mutation scores passed: critical 82.65% (minimum 80%), managed 74.69% (minimum 55%), and installer 66.39% (minimum 55%).
The original aggregate command stopped during the installer shard. The installer shard then passed in a separate run.
All 14 recorded inputs for these shards match the final source. The shared shard configuration changes only the unrelated job-control line range.
The supplemental render shard passed at 59.64% (minimum 55%). The supplemental full claude-cli run stopped and has no passing result.

### Model comparison

The controller scored 21 cases across seven configurations. One extra call stopped before edits because the native claim check could not verify TLS certificates.
A process-local `SSL_CERT_FILE=/etc/ssl/cert.pem` resolved that harness failure. TLS verification stayed enabled. The failed call remains in the evidence.

All seven diagnoses identified the cause. The controller ran their proposed regressions: each failed against the original code and passed with the proposed fix.
All seven reviews found both expected defects, with no misses or false positives. All seven fixes passed six independent checks each.
All actual primary models matched their requested full IDs. No model fallback occurred.

| Primary model | Advisor policy | Diagnosis seconds | Review seconds | Fix seconds | Observed advisor calls (diagnosis/review/fix) |
|---|---|---:|---:|---:|---|
| `claude-opus-5-5` | off | 39.6 | 22.6 | 48.1 | 0/0/0 |
| `claude-opus-5-5` | Fable 5.1 | 38.4 | 23.3 | 106.3 | 0/0/1 |
| `claude-sonnet-5-5` | off | 31.8 | 17.1 | 46.0 | 0/0/0 |
| `claude-sonnet-5-5` | Fable 5.1 | 34.2 | 18.1 | 45.5 | 0/0/0 |
| `claude-haiku-5-5` | off | 42.5 | 26.1 | 44.3 | 0/0/0 |
| `claude-haiku-5-5` | Fable 5.1 | 116.1 | 35.5 | 80.0 | 1/0/1 |
| `claude-fable-5-1` | off | 45.7 | 42.8 | 58.1 | 0/0/0 |

These are single runs on small fixtures. Durations include runtime overhead and concurrent load. They do not establish model superiority or advisor latency costs.
Advisor calls occurred in one Opus case and two Haiku cases. Sonnet accepted the explicit policy, but no Sonnet case showed an advisor call.
Usage and cost data were unavailable. The stream did not identify the advisor model. A requested Fable policy does not prove Fable answered.
The comparison used one frozen telemetry candidate. The final callback-failure fix did not change the successful path that these cases exercised.
Model defaults remain unchanged.

### Live qualification and remaining gates

The installed v1.7.12 research workflow passed the new gate at exact commit `fb6c091cb0372fa716fa2d4ff110ff93453a5e61`.
Its memo and critique used Sonnet 5.5, with no fallback. The gate checked both exact Brave tools and unchanged workspace entries.
Candidate research passed at `096cfd065a8dee7bce0a4c43c2bcead8b66d54f4`. Both native stages used Sonnet 5.5 with the frozen Fable advisor policy.
Both reported zero advisor calls, without fallback. The gate checked 20 repository citations, four web citations, and unchanged workspace entries.
Candidate design passed at the same commit. Its memo and critique used Haiku 5.5 with advisor off, zero calls, and no fallback.
The gate checked 37 repository citations, five web citations, and unchanged workspace entries.
Both candidate workflows completed memo, critique, and synthesis without retries. The controller read both full final results.
Haiku completed the evidence review. The controller reconciled prompt hashes, bound source hashes to commits, and corrected stale records.
Existing tests cover duplicate advisor records and native Windows rejection. No new code defect was established.
Exact Claude CLI versions were not bound to each benchmark or final live result. Earlier probes recorded 2.1.296, without per-run provenance.
Benchmark grading was not blinded. Exclusion of an optional memory-growth observation was a post-hoc, contract-based judgment.
These evidence limits remain explicit. No merge, release, installation activation, or client restart is claimed.

Low-severity review follow-ups remain outside this track: the theoretical process-group ID reuse window and native Windows termination behavior.
No failure reproduced for either concern. Native Windows peer execution remains unsupported and fails closed.
A zero-call advisor observation remains `not_observed`. The gate qualifies policy consistency, not guaranteed advisor invocation.

Local detailed evidence is in `.superpowers/sdd/2026-10-13-reliability-advisor/`. This directory is ignored and is not a published artifact.
Key records: `combined-check-2-result.json`, `mutation-reuse-final.json`, `benchmark-runs.json`, and `benchmark-summary.json`.
