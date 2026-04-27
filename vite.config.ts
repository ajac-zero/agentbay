import { defineConfig } from "vite-plus";
import devServer from "@hono/vite-dev-server";

export default defineConfig({
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
  build: {
    outDir: "dist",
    target: "node20",
    ssr: "src/main.ts",
    rollupOptions: {
      output: {
        entryFileNames: "main.js",
        format: "es",
      },
    },
  },
  plugins: [
    devServer({
      entry: "src/server.ts",
    }),
  ],
});
