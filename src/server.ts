import { Hono } from "hono";

const app = new Hono();

app.get("/healthz", (c) => c.text("ok", 200));

export default app;
