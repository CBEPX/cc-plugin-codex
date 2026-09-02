# Task 5: exact-head full-unit-gate regressions

Base and fixed HEAD before this task: `2ad7bbd40f0247c22c48c68ab1d8c89ce0974012`.

## RED evidence

`npm run check -- --test-name-pattern='reservation keys|mutation'` ran the unit suite and reported 917 pass / 2 fail:

1. `tests/attempt-reservations.test.mjs:118` expected only `epoch`, `leaseDigest`, and `reservedAt`; the intentionally persisted `previousFailureDetail` was present.
2. `tests/mutation-config.test.mjs:36` reported `scripts/lib/state.mjs:420-468` excluded `normalizeStoredJob` at `427-470`.

## Minimal fix

- The reservation shape assertion now includes `previousFailureDetail` and asserts its initial value is `null`. No workflow production behavior changed.
- The same AST-derived exact first/last function boundaries were updated in both the mutation expectation table and Stryker shard configuration:

| File | Old | New |
| --- | --- | --- |
| `scripts/lib/state.mjs` | `420-468` | `420-470` |
| `scripts/lib/state.mjs` | `545-886` | `547-888` |
| `scripts/lib/state.mjs` | `935-1107` | `937-1109` |
| `scripts/lib/state.mjs` | `1173-1235` | `1175-1240` |
| `scripts/lib/state.mjs` | `1241-1287` | `1246-1292` |
| `scripts/lib/tracked-jobs.mjs` | `273-357` | `311-395` |
| `scripts/lib/tracked-jobs.mjs` | `376-530` | `414-547` |

## GREEN evidence

- `node --import ./tests/test-env.mjs --test tests/attempt-reservations.test.mjs tests/mutation-config.test.mjs`: 6 pass / 0 fail.
- `npm run test`: 919 pass / 0 fail, 134 suites.
- `git diff --check`: exit 0.

## Self-review

- Reservation leases remain checked as SHA-256-shaped and absent from stored workflow bytes; the new field is asserted `null` before any failure can be recorded.
- Every adjusted range starts at the first named `FunctionDeclaration` and ends at the last named `FunctionDeclaration`, as enforced by `mutation-config.test.mjs`; no mutation scope was broadened past those target functions.
- Diff is test/config/report-only; no production workflow semantics or mutation target files changed.
