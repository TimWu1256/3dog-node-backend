/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "CommonJS",
          moduleResolution: "node",
          esModuleInterop: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    // Remap .js imports (NodeNext style) → no-extension for Jest to resolve to .ts
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  verbose: true,
  maxWorkers: 4,
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  testTimeout: 60000,
  forceExit: true,
};
