import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: [
      "src/index.ts",
      "src/stores/memory.ts",
      "src/stores/libsql.ts",
      "src/tools/index.ts",
      "src/adapters/eve.ts",
      "src/sidecar/index.ts",
    ],
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
