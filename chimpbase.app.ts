import { defineChimpbaseApp } from "chimpbase/core";

import { assetsImplementation } from "./src/modules/assets/implementation.ts";
import { definitionsImplementation } from "./src/modules/definitions/implementation.ts";
import { effectsImplementation } from "./src/modules/effects/implementation.ts";
import { executionImplementation } from "./src/modules/execution/implementation.ts";
import { intakeImplementation } from "./src/modules/intake/implementation.ts";
import { operationsImplementation } from "./src/modules/operations/implementation.ts";
import { runsImplementation } from "./src/modules/runs/implementation.ts";

export default defineChimpbaseApp({
  project: { name: "software-factory" },
  modules: [
    assetsImplementation,
    definitionsImplementation,
    effectsImplementation,
    executionImplementation,
    intakeImplementation,
    operationsImplementation,
    runsImplementation,
  ],
});
