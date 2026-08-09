import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/testing.ts"],
    dts: {
      tsgo: true,
    },
    exports: true,
  },
});
