import { logger, toErrCtx } from "./logger.js";
import { runRuntimeMigrations } from "./runtime/store.js";

try {
  await runRuntimeMigrations();
  logger.info("runtime migrations applied");
} catch (error) {
  logger.error("runtime migrations failed", { err: toErrCtx(error) });
  process.exitCode = 1;
}
