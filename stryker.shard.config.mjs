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
      "scripts/lib/process.mjs:75-123",
      "scripts/lib/process.mjs:125-196",
      "scripts/lib/process.mjs:202-385",
      "scripts/lib/process.mjs:408-543",
    ],
  },
  state: {
    command: "npm run test:mutation:state:unit",
    mutate: [
      // Persistence lifecycle, session lookup, and terminal job transitions.
      "scripts/lib/state.mjs:87-108",
      "scripts/lib/state.mjs:177-268",
      "scripts/lib/state.mjs:300-350",
      "scripts/lib/state.mjs:427-813",
      "scripts/lib/state.mjs:862-1035",
      "scripts/lib/state.mjs:1101-1166",
      "scripts/lib/state.mjs:1172-1218",
    ],
  },
  "tracked-jobs": {
    command: "npm run test:mutation:state:unit",
    mutate: [
      "scripts/lib/tracked-jobs.mjs:30-78",
      "scripts/lib/tracked-jobs.mjs:308-392",
      "scripts/lib/tracked-jobs.mjs:411-544",
    ],
  },
  "job-control": {
    command: "npm run test:mutation:job-control:unit",
    // Public selection and cancellation paths; process mechanics are covered separately.
    mutate: ["scripts/lib/job-control.mjs:212-478"],
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
      "scripts/installer-cli.mjs:98-236",
      "scripts/installer-cli.mjs:277-377",
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
