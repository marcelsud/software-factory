import { defineChimpbaseModuleImplementation } from "chimpbase/core";
import { MODULE_RESOURCES } from "../../contracts/index.ts";

import { operations } from "./interface.ts";

function unavailable(call: string): never {
  throw new Error(
    `module_unavailable: operations.${call} is not available in the foundation composition`,
  );
}

export const operationsImplementation = defineChimpbaseModuleImplementation({
  interface: operations,
  calls: {
    listRuns() {
      return unavailable("listRuns");
    },
    showRun() {
      return unavailable("showRun");
    },
    getHealth() {
      return unavailable("getHealth");
    },
    listEvents() {
      return unavailable("listEvents");
    },
    listEffects() {
      return unavailable("listEffects");
    },
  },
  resources: MODULE_RESOURCES.operations,
});
