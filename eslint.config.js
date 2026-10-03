import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "test-results/**", "playwright-report/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["tests/browser/**/*.js"],
    languageOptions: { globals: Object.fromEntries([
      "window", "document", "DOMException", "IDBFactory", "IDBObjectStore", "AudioContext", "Worker",
      "navigator", "AudioWorklet", "AudioBufferSourceNode", "MediaStream", "ErrorEvent", "MessageEvent",
      "PageTransitionEvent",
    ].map((name) => [name, "readonly"])) },
  },
);
