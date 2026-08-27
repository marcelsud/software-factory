import { defineChimpbaseModuleImplementation } from "chimpbase/core";
import { MODULE_RESOURCES } from "../../contracts/index.ts";

import { effects } from "./interface.ts";

function unavailable(call: string): never {
  throw new Error(
    `module_unavailable: effects.${call} is not available in the foundation composition`,
  );
}

export const effectsImplementation = defineChimpbaseModuleImplementation({
  interface: effects,
  calls: {
    requestEffect() {
      return unavailable("requestEffect");
    },
    getReceipt() {
      return unavailable("getReceipt");
    },
    reconcileEffect() {
      return unavailable("reconcileEffect");
    },
  },
  resources: MODULE_RESOURCES.effects,
});
