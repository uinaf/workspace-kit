import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    server: {
      deps: {
        // vite-plus/test re-exports vitest; without inlining, the re-export
        // externalizes to a second vitest instance and no suite is found
        // (upstream #1113 fixed the expect.extend flavor of this).
        inline: ["vite-plus"],
      },
    },
  },
  // tsdown options: the published artifact is the bundled bin only.
  pack: {
    entry: ["src/cli.ts"],
    dts: false,
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
