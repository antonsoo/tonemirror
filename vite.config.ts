/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { contentSecurityPolicy } from "./vite.csp";

export default defineConfig({
  base: "/tonemirror/",
  plugins: [contentSecurityPolicy()],
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/core/**"],
    },
  },
});
