import { defineConfig, bindings } from "cf/config";

export default defineConfig({
  worker: {
    name: "hae-api",
    compatibilityDate: "2025-08-01",
    entrypoint: "./src/worker.js",
    env: {
      DB: bindings.d1({ name: "hae-health", id: "b91ee90f-e928-497c-b15a-5d5cd7d5f59b" }),
      READ_KEY: bindings.secret(),
      WRITE_KEY: bindings.secret(),
      DASH_TOKEN: bindings.secret(),
    },
  },
});
