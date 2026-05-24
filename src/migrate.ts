import { runRuntimeMigrations } from "./runtime/store.js";

try {
  await runRuntimeMigrations();
  console.log("agentbay runtime migrations applied");
} catch (error) {
  console.error("agentbay runtime migrations failed");
  console.error(error);
  process.exitCode = 1;
}
