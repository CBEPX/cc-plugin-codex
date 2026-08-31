import { casStartWorkflowStage } from "../../scripts/lib/workflows.mjs";

try {
  const [cwd, id, revision, epoch] = process.argv.slice(2);
  const workflow = casStartWorkflowStage(cwd, id, {
    stage: "memo",
    revision: Number(revision),
    epoch: Number(epoch),
  });
  process.stdout.write(`${workflow.revision}\n`);
} catch (error) {
  process.stderr.write(`${error?.code ?? error?.message ?? error}\n`);
  process.exitCode = 1;
}
