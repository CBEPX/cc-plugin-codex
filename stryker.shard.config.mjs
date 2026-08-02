import baseConfig from "./stryker.config.mjs";

const shardName = process.env.CC_MUTATION_SHARD;
const shards = {
  render: {
    command: "npm run test:mutation:render:unit",
    mutate: ["scripts/lib/render.mjs"],
  },
  "claude-cli": {
    command: "npm run test:mutation:claude-cli:unit",
    mutate: [
      "scripts/lib/claude-cli.mjs",
      "scripts/lib/process.mjs:9-54",
      "scripts/lib/process.mjs:75-106",
      "scripts/lib/process.mjs:108-179",
      "scripts/lib/process.mjs:185-367",
      "scripts/lib/process.mjs:390-504",
    ],
  },
  state: {
    command: "npm run test:mutation:state:unit",
    mutate: [
      // Persistence lifecycle, session lookup, and terminal job transitions.
      "scripts/lib/state.mjs:180-220",
      "scripts/lib/state.mjs:289-363",
      "scripts/lib/state.mjs:395-443",
      "scripts/lib/state.mjs:520-761",
      "scripts/lib/state.mjs:810-982",
      "scripts/lib/state.mjs:1048-1105",
      "scripts/lib/state.mjs:1111-1157",
      "scripts/lib/tracked-jobs.mjs:26-39",
      "scripts/lib/tracked-jobs.mjs:356-482",
    ],
  },
  "job-control": {
    command: "npm run test:mutation:job-control:unit",
    // Public selection and cancellation paths; process mechanics are covered separately.
    mutate: ["scripts/lib/job-control.mjs:144-247"],
  },
  managed: {
    command: "npm run test:mutation:managed:unit",
    mutate: [
      "scripts/lib/managed-global-integration.mjs",
      "hooks/lib/plugin-install-guard.mjs",
    ],
  },
  installer: {
    command: "npm run test:mutation:installer:unit",
    mutate: [
      // Marketplace validation/config cleanup and the complete uninstall orchestration.
      "scripts/installer-cli.mjs:96-234",
      "scripts/installer-cli.mjs:275-371",
    ],
  },
};

const shard = shards[shardName];
if (!shard) {
  throw new Error(`Unknown mutation shard: ${shardName || "<missing>"}`);
}

export default {
  ...baseConfig,
  commandRunner: {
    command: shard.command,
  },
  mutate: shard.mutate,
  thresholds: {
    high: 80,
    low: 55,
    break: 55,
  },
  incrementalFile: `reports/stryker-${shardName}-incremental.json`,
  htmlReporter: {
    fileName: `reports/mutation/${shardName}.html`,
  },
  jsonReporter: {
    fileName: `reports/mutation/${shardName}.json`,
  },
};
