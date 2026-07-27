import fullConfig from "./stryker.config.mjs";

export default {
  ...fullConfig,
  commandRunner: {
    command: "npm run test:mutation:critical:unit",
  },
  mutate: [
    "scripts/lib/args.mjs",
    "scripts/lib/structured-output.mjs",
  ],
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  incrementalFile: "reports/stryker-critical-incremental.json",
  htmlReporter: {
    fileName: "reports/mutation/critical.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/critical.json",
  },
};
