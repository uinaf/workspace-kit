import { defineConfig } from "vite-plus";
import { kitVersion } from "./src/version.ts";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
    server: {
      deps: {
        inline: ["vite-plus"],
      },
    },
  },
  pack: {
    entry: ["src/cli.ts"],
    dts: false,
    define: {
      __WORKSPACE_KIT_VERSION__: JSON.stringify(kitVersion()),
    },
  },
  staged: {
    "*.{js,mjs,cjs,ts,mts,cts}": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["parity/legacy/**", "parity/fixtures/**"],
  },
  lint: {
    ignorePatterns: ["parity/legacy/**", "parity/fixtures/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
});
