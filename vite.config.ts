import { defineConfig } from "vite-plus";
import devServer from "@hono/vite-dev-server";

export default defineConfig({
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
  plugins: [
    devServer({
      entry: "src/server.ts",
    }),
  ],
});
