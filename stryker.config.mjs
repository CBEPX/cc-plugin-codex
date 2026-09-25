export default {
  testRunner: "command",
  commandRunner: {
    command: "npm run test:mutation:critical:unit",
  },
  coverageAnalysis: "off",
  // The command runner never type-checks, and TypeScript 7 dropped the config-parsing API
  // that Stryker's preprocessor calls when the root tsconfig.json is in the sandbox.
  ignorePatterns: ["/tsconfig.json", "/tsconfig.tests.json"],
  mutate: [
    "scripts/lib/args.mjs",
    "scripts/lib/structured-output.mjs",
  ],
  reporters: ["progress", "clear-text", "html", "json"],
  clearTextReporter: {
    reportMutants: false,
    reportTests: false,
    reportScoreTable: true,
    allowEmojis: false,
  },
  thresholds: {
    high: 80,
    low: 55,
    break: 55,
  },
  concurrency: 4,
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
