import { activateWorkflowAttempt } from "../../scripts/lib/workflows.mjs";

const [cwd, id, revision, epoch] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { lease, stage = "memo", branchId = "codex" } = JSON.parse(input);
try {
  const workflow = activateWorkflowAttempt(cwd, id, {
    stage,
    ...(branchId ? { branchId } : {}),
    revision: Number(revision),
    epoch: Number(epoch),
    lease,
  });
  process.stdout.write(`${JSON.stringify(workflow)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code ?? error?.message ?? error}\n`);
  process.exitCode = 1;
}
