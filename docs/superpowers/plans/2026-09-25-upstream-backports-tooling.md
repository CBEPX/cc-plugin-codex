# Бэкпорты и обновление инструментов

Источник требований: согласованный пользователем план семи PR и двух релизных волн в сессии 01a0d2ba-a294-71a1-b572-d571b2ac4082. База: 66846d9080dd749dcc0b9ef9c37af8d5fd4cc203 (1.7.7). Исследование: workflow-mufhfp8e-1b947ca5, completed.

Трекер: https://github.com/CBEPX/cc-plugin-codex/issues/60.

## Общие ограничения

Один PR на часть, последовательное принятие. Claude через cc участвует в уточнении, реализации, свежем review, проверке доказательств и релизе; Codex независимо выполняет E2E изменённого поведения до commit/PR. У автора и reviewer разные сессии. Model IDs: claude-opus-5-5, claude-fable-5-1; effort явный для каждого задания. Глобальные defaults сохраняются.

Сохранить Node >=18, Node24 tooling, plugin_hooks, identity-checked cancellation, peer recovery, read/export contracts и пороги проверок. Не добавлять runtime dependencies, не обновлять ESLint/globals, не включать publishers. Никогда не запускать gitlab, telegram, cloudflare-api, trace-mcp; не выполнять общий mcp-diagnose.

Начало: новая umbrella issue на английском, этот внутренний план на русском, task-owned ledger и отдельный worktree. Реализация с RED→GREEN; отчёты и логи в task-owned execution directory. Workers не делают commit/push/release до независимой проверки родителем.

## Task 1: Stop-review через Git MCP

Claude implementation: Opus 5.5/high; fresh adversarial review: Opus 5.5/high.
Выборочный порт upstream PR57 (928f90a9fa106934087169f8b1a5967d9570e03d). Переиспользовать createReviewMcpConfig, cleanupReviewMcpConfig и REVIEW_MCP_ALLOWED_TOOLS. Stop allowlist: Read/Glob/Grep и семь точных Git MCP tools, без Bash. Объявить Stop-константу после MCP-констант. runStopReview использует resolveWorkspaceRoot(cwd), strictMcpConfig и finally cleanup; не подменять текущий worktree главным checkout. Gate продолжает наследовать model/effort пользователя.

Сначала regression tests на реальный hook subprocess: независимые ожидаемые разрешения, strict config с единственным gitReview, CC_GIT_ROOT, отсутствие принудительных model/effort, cleanup при ALLOW/BLOCK/error. Показать RED до минимальных правок production. Затем GREEN, npm test, lint и оба typecheck. Родитель выполняет живой Claude Stop-review/Git MCP E2E и проверяет запрещённые инструменты; mocks этого не заменяют. Не переносить bounded reasons в эту часть.

Уточнение по живому E2E: одного исключения Bash из allowedTools недостаточно — унаследованные permissions могут разрешать его. Task 1 также ограничивает доступные built-in tools через общий runClaudeReview; обычные task-запуски сохраняют поведение. Проверка включает широкие унаследованные разрешения Bash/записи и фактическое отсутствие этих инструментов.

Уточнение после проверки кандидата: fallback-подсказки для больших diff переводятся на MCP/Read; минимальный cached-параметр Git MCP сохраняет просмотр staged-only изменений без Bash. Проверка использует различающиеся index/worktree при одинаковых HEAD/worktree.

## Task 2: Ограниченный reason и turn-end

Fable 5.1/medium; review Opus 5.5/medium. После Task 1: полный snapshot сохраняется прежде выдачи reason; до 1500 символов combined running-task note + reason, затем многоточие и snapshot reference. Проверить длинный Unicode, error output, короткий reason и валидный JSON. Исправить README/setup/prompts по фактическому turn-end поведению; не добавлять отвергнутые upstream trigger telemetry/default detection. Gate model/effort остаются inherited.

## Task 3: Установленный SessionEnd E2E

Opus 5.5/high; review Fable 5.1/high. Адаптировать upstream PR99 к существующей marketplace fixture: изолированный CODEX_HOME, реальный Codex, доверенные точные hashes хуков. Доказать создание SessionStart marker до завершения и его удаление реальным SessionEnd. Использовать нынешний plugins/data/cc и существующий codexAvailable()/CI guard, без нового skip mode. Сохранить lifecycle semantics и regressions. Новый тест должен исполняться в CI, а не удовлетворяться skip.

## Task 4: Acorn preparation

Fable 5.1/high; review Opus 5.5/medium. Явно объявить уже установленный Acorn 8.16.0 devDependency. Заменить только TypeScript compiler-API lookup в tests/mutation-config.test.mjs; сохранить export spans и полные границы 52 функций/18 диапазонов. Проверить guard, mutation dry-run и затронутый shard. Не использовать unstable TS7 AST API.

## Task 5: TypeScript 7.0.2

Fable 5.1/high; review Opus 5.5/high. После Task 4 обновить declaration/lock и platform packages; минимальный callback arity fix в matchJobReference: predicate принимает _job. Иные правки только по фактическим typecheck errors. Source/test typechecks, mutation guard и Windows native compiler installation должны пройти. Сохранить caret style и точные lock resolutions, не вносить incidental lock churn.

## Task 6: Node types 26.2.0

Fable 5.1/medium; review Opus 5.5/medium. Обновить @types/node и необходимый undici-types отдельно. Оба typecheck и Node18 unit/integration; не использовать новые runtime APIs, недоступные Node18.

## Task 7: GitHub Actions

Fable 5.1/medium; review Opus 5.5/medium. Во всех четырёх workflows закрепить checkout 7.0.1 = 3d3c42e5aac5ba805825da76410c181273ba90b1, setup-node 7.0.0 = 820762786026740c76f36085b0efc47a31fe5020. Исправить version comments; сохранить upload-artifact 7.0.1, triggers, permissions, cache, Node18 job и disabled_manually обоих publishers. Приёмка: hosted Linux/macOS/Windows CI и полный mutation run с upload/merge artifacts.

## Релизные волны и последующая работа

Предварительно 1.7.8 = Tasks 1–3, 1.7.9 = Tasks 4–7. До выпуска каждой волны: full check, coverage, full mutation, свежий Claude Opus/high review доказательств, квалификация локально установленного кандидата Opus/Fable. Завершить активные jobs перед установкой. Зафиксировать requested/final model, fallback, SHA исходников, хеши artifact/cache. Публиковать GitHub tgz + sha256 только из квалифицированного кандидата, проверить публичный readback; npm/marketplace publishers остаются отключёнными. Недоступный E2E оставляет gate открытым.

После обеих волн отдельный cc:design (Opus 5.5/high + Codex) для marketplace state/migration и возраста fallback marker: setup-owned migration, idle workers, legacy/rollback preservation, отказ при ambiguous ownership/conflicts, stale marker без unlink-on-read. Имплементация миграции не входит в эти семь PR.
