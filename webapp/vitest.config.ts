import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Unit-test config for the webapp backend logic under `lib/`.
 *
 * `server-only` is a marker module Next.js injects to fail the build when a
 * server module is pulled into a client bundle. Under Node/vitest there is no
 * bundler condition to satisfy, so we alias it to an empty stub — the tested
 * modules never rely on its (absent) runtime behaviour, only on the boundary
 * it documents.
 */
export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "test/**/*.test.ts"],
  },
});
