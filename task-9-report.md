# Task 9: dependency audit cleanup (#40)

Base: `9442c3edd9d8ad60fcfe44653834f3ed049f06c3`.

## Scope

No runtime dependency or direct dependency major changed. The only manifest change is the scoped `typed-rest-client > qs` override; `typed-rest-client` pins `qs` to `6.15.1`, so its previous `6.15.3` override could not receive the fix through its own range.

| Advisory chain | Before | After |
| --- | --- | --- |
| `eslint > @humanfs/node` (`GHSA-p498-v437-472g`) | `0.16.7` | `0.16.8` |
| `minimatch > brace-expansion` (`GHSA-rgw5-rvv9-x895`) | `5.0.8` | `5.0.9` |
| `@babel/helper-compilation-targets > browserslist` (`GHSA-c83g-rgw3-j3cx`, `GHSA-73wf-gq98-2v4g`) | `4.28.4` | `4.28.8` |
| `@stryker-mutator/core > ajv > fast-uri` (`GHSA-7p8r-x3mc-p8w7`, `GHSA-5jgf-p345-68v8`, `GHSA-f65p-4m7j-42xc`, `GHSA-fph4-wmhf-6fwf`, `GHSA-jqff-g426-hqxp`) | `3.1.4` | `3.1.7` |
| `@stryker-mutator/core > typed-rest-client > qs` (`GHSA-x5fp-wj9c-mxmx`, `GHSA-4mjr-xmp4-gh2g`) | `6.15.3` | `6.16.0` |

The lock refresh also moves the owners' compatible metadata dependencies (`@humanfs/core` `0.19.1` -> `0.19.2`, adds `@humanfs/types` `0.15.0`, and refreshes the `browserslist` data chain). Direct versions remain `@eslint/js` `10.0.1`, `@stryker-mutator/core` `9.6.1`, `@types/node` `25.6.2`, `c8` `12.0.0`, `eslint` `10.3.0`, `globals` `17.6.0`, and `typescript` `6.0.3`.

## Files

- `package.json`: `typed-rest-client > qs` override `6.15.3` -> `6.16.0`.
- `package-lock.json`: deterministic compatible transitive refresh.
- `task-9-report.md`: this evidence record.

## Commands and results

- `npm audit --json`: before `6` dev-only findings (3 moderate, 3 high); after `0`.
- `npm audit --omit=dev --json`: `0` before and after.
- `npm explain @humanfs/node brace-expansion browserslist fast-uri qs typed-rest-client --json`: confirmed the chains above.
- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` then `npm ci --ignore-scripts --no-audit --no-fund`: regenerated and installed the lock deterministically (`257` packages).
- `npm ls --all --json`: no problems.
- `npm run test:mutation:dry-run`: passed; 2 files / 294 mutants discovered, no mutations executed.
- `npm run check`: exit `0`; unit `956/956`, integration passed, E2E `24/24`.

## npm notes

The targeted `npm update` invocation reported `up to date` for transitive package names. `npm install --package-lock-only` performed the intended range-respecting lock resolution. No `npm audit fix`, Stryker 10 upgrade, broad mutation run, or runtime dependency change was used.
