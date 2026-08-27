import { defineChimpbaseModuleImplementation } from "chimpbase/core";

import { execution } from "./interface.ts";

function unavailable(call: string): never {
  throw new Error(
    `module_unavailable: execution.${call} is not available in the foundation composition`,
  );
}

export const executionImplementation = defineChimpbaseModuleImplementation({
  interface: execution,
  calls: {
    requestAttempt() {
      return unavailable("requestAttempt");
    },
    getAttempt() {
      return unavailable("getAttempt");
    },
  },
  resources: {},
});
