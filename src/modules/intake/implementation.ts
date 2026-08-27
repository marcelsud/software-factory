import { defineChimpbaseModuleImplementation } from "chimpbase/core";

import { intake } from "./interface.ts";

function unavailable(call: string): never {
  throw new Error(
    `module_unavailable: intake.${call} is not available in the foundation composition`,
  );
}

export const intakeImplementation = defineChimpbaseModuleImplementation({
  interface: intake,
  calls: {
    acceptSourceEvent() {
      return unavailable("acceptSourceEvent");
    },
    getSourceCursor() {
      return unavailable("getSourceCursor");
    },
    pollRepository() {
      return unavailable("pollRepository");
    },
  },
  resources: {},
});
