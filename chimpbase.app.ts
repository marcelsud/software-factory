import { defineChimpbaseApp } from "chimpbase/core";

import {
  type AssetsImplementationDependencies,
  createAssetsImplementation,
} from "./src/modules/assets/implementation.ts";
import { definitionsImplementation } from "./src/modules/definitions/implementation.ts";
import {
  createEffectsImplementation,
  type EffectsImplementationDependencies,
} from "./src/modules/effects/implementation.ts";
import {
  createExecutionImplementation,
  type ExecutionImplementationDependencies,
} from "./src/modules/execution/implementation.ts";
import {
  createIntakeImplementation,
  type IntakeImplementationDependencies,
  unavailableGitHubReadTransport,
} from "./src/modules/intake/implementation.ts";
import {
  createOperationsImplementation,
  type OperationsImplementationDependencies,
} from "./src/modules/operations/implementation.ts";
import {
  createRunsImplementation,
  FACTORY_RUNS_V2_WORKFLOW_DIGEST,
  type RunsImplementationDependencies,
} from "./src/modules/runs/implementation.ts";

export type FactoryAppDependencies = AssetsImplementationDependencies &
  EffectsImplementationDependencies &
  ExecutionImplementationDependencies &
  IntakeImplementationDependencies &
  OperationsImplementationDependencies &
  RunsImplementationDependencies;
export { FACTORY_RUNS_V2_WORKFLOW_DIGEST };

export function createSoftwareFactoryApp(dependencies?: FactoryAppDependencies) {
  return defineChimpbaseApp({
    project: { name: "software-factory" },
    modules: [
      createAssetsImplementation(dependencies),
      definitionsImplementation,
      createEffectsImplementation(dependencies),
      createExecutionImplementation(dependencies),
      createIntakeImplementation(dependencies ?? { readTransport: unavailableGitHubReadTransport }),
      createOperationsImplementation(dependencies),
      createRunsImplementation({
        ...dependencies,
        strictEffects:
          dependencies?.gitPublisher !== undefined ||
          dependencies?.githubWriteTransport !== undefined,
      }),
    ],
    telemetry: { persist: { log: true, metric: true, trace: true } },
    worker: { maxAttempts: 5, retryDelayMs: 1_000 },
  });
}

export default createSoftwareFactoryApp();
