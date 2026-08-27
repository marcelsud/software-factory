import { defineChimpbaseApp } from "chimpbase/core";

import { assetsImplementation } from "./src/modules/assets/implementation.ts";
import { definitionsImplementation } from "./src/modules/definitions/implementation.ts";
import { effectsImplementation } from "./src/modules/effects/implementation.ts";
import { executionImplementation } from "./src/modules/execution/implementation.ts";
import {
  createIntakeImplementation,
  type IntakeImplementationDependencies,
  unavailableGitHubReadTransport,
} from "./src/modules/intake/implementation.ts";
import { operationsImplementation } from "./src/modules/operations/implementation.ts";
import {
  createRunsImplementation,
  FACTORY_RUNS_V2_WORKFLOW_DIGEST,
  type RunsImplementationDependencies,
} from "./src/modules/runs/implementation.ts";

export type FactoryAppDependencies = IntakeImplementationDependencies &
  RunsImplementationDependencies;
export { FACTORY_RUNS_V2_WORKFLOW_DIGEST };

export function createSoftwareFactoryApp(dependencies?: FactoryAppDependencies) {
  return defineChimpbaseApp({
    project: { name: "software-factory" },
    modules: [
      assetsImplementation,
      definitionsImplementation,
      effectsImplementation,
      executionImplementation,
      createIntakeImplementation(dependencies ?? { readTransport: unavailableGitHubReadTransport }),
      operationsImplementation,
      createRunsImplementation(dependencies),
    ],
    worker: { maxAttempts: 5, retryDelayMs: 1_000 },
  });
}

export default createSoftwareFactoryApp();
