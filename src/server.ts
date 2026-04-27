import { Hono } from "hono";
import { config } from "./config.ts";

void config;

const app = new Hono();

app.get("/healthz", (c) => c.text("ok", 200));

export default app;
