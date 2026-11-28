import uinaf, { env, ignorePatterns } from "@uinaf/oxlint-config/vite-plus";
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
    extends: [uinaf],
    env,
    ignorePatterns: [...ignorePatterns, "parity/legacy/**", "parity/fixtures/**"],
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
      "anti-slop/no-runtime-typeof": "off",
      "anti-slop/no-unknown-parameters": "off",
      "anti-slop/require-safety-comment-for-type-assertion": "off",
      curly: "off",
      "no-console": "off",
      "preserve-caught-error": "off",
      "quality/no-conditional-empty-object-spread": "off",
      "quality/no-known-value-widening": "off",
      "quality/no-unknown-returns": "off",
      "quality/no-unsafe-dictionary-type": "off",
      "typescript/no-unsafe-argument": "off",
      "typescript/no-unsafe-assignment": "off",
      "typescript/no-unsafe-call": "off",
      "typescript/no-unsafe-member-access": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
});
