import { readBoolean, readNumber } from "../util.js";
import type { PostgresRuntimeStoreOptions } from "./postgres.js";
import type { ExecutionStore } from "../execution/store.js";
import type { EventAdmissionStore } from "../execution/store.js";
import type { OutboxStore } from "../outbox/types.js";
import type { DispatcherExecutionStore } from "../dispatch/store.js";
import type { TriggerStore } from "../control/trigger.js";
import type { BindingStore } from "../control/binding.js";
import type { ConnectionStore } from "../connection/index.js";
import type { RevisionResolutionStore } from "../revision/types.js";
import type { GitHubEffectStore } from "../connectors/github/effects-api.js";
import type { ScheduleStore } from "../schedule/types.js";

export type RuntimeStore = ExecutionStore & TriggerStore & BindingStore & ConnectionStore & EventAdmissionStore & OutboxStore & DispatcherExecutionStore & RevisionResolutionStore & GitHubEffectStore & ScheduleStore & {
  close: () => Promise<void>;
};

export async function createRuntimeStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeStore> {
  const { createPostgresRuntimeStore } = await import("./postgres.js");
  return createPostgresRuntimeStore(readPostgresRuntimeStoreOptions(env));
}

export async function runRuntimeMigrations(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { migratePostgresRuntimeStore } = await import("./postgres.js");
  await migratePostgresRuntimeStore(readPostgresRuntimeStoreOptions(env));
}

function readPostgresRuntimeStoreOptions(env: NodeJS.ProcessEnv): PostgresRuntimeStoreOptions {
  const connectionString = env.AGENTBAY_DATABASE_URL ?? env.DATABASE_URL;
  const host = env.AGENTBAY_DATABASE_HOST;
  if (!connectionString && !host) {
    throw new Error("AGENTBAY_DATABASE_URL, DATABASE_URL, or AGENTBAY_DATABASE_HOST must be set");
  }

  return {
    database: env.AGENTBAY_DATABASE_NAME,
    host,
    migrationsFolder: env.AGENTBAY_DATABASE_MIGRATIONS_FOLDER,
    password: env.AGENTBAY_DATABASE_PASSWORD,
    port: readNumber(env.AGENTBAY_DATABASE_PORT, 5432),
    user: env.AGENTBAY_DATABASE_USER,
    ...(connectionString ? { connectionString } : {}),
    ssl: readBoolean(env.AGENTBAY_DATABASE_SSL, false),
    sslRejectUnauthorized: readBoolean(env.AGENTBAY_DATABASE_SSL_REJECT_UNAUTHORIZED, false),
  };
}
