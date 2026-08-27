import { defineChimpbaseModuleImplementation } from "chimpbase/core";
import { MODULE_RESOURCES } from "../../contracts/index.ts";

import { assets } from "./interface.ts";

function unavailable(call: string): never {
  throw new Error(
    `module_unavailable: assets.${call} is not available in the foundation composition`,
  );
}

export const assetsImplementation = defineChimpbaseModuleImplementation({
  interface: assets,
  calls: {
    resolveSkill() {
      return unavailable("resolveSkill");
    },
    putArtifact() {
      return unavailable("putArtifact");
    },
    getArtifact() {
      return unavailable("getArtifact");
    },
    materializeArtifact() {
      return unavailable("materializeArtifact");
    },
    listRunArtifacts() {
      return unavailable("listRunArtifacts");
    },
  },
  resources: MODULE_RESOURCES.assets,
});
