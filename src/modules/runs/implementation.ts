import { defineChimpbaseModuleImplementation } from "chimpbase/core";
import { MODULE_RESOURCES } from "../../contracts/index.ts";

import { runs } from "./interface.ts";

function unavailable(call: string): never {
  throw new Error(
    `module_unavailable: runs.${call} is not available in the foundation composition`,
  );
}

export const runsImplementation = defineChimpbaseModuleImplementation({
  interface: runs,
  calls: {
    startRun() {
      return unavailable("startRun");
    },
    getRun() {
      return unavailable("getRun");
    },
    applyOperatorCommand() {
      return unavailable("applyOperatorCommand");
    },
  },
  resources: MODULE_RESOURCES.runs,
});
