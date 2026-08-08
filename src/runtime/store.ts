import { readBoolean } from "../util.js";
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
import type { ObservabilityStore } from "../observability/types.js";

export type RuntimeStore = ExecutionStore & TriggerStore & BindingStore & ConnectionStore & EventAdmissionStore & OutboxStore & DispatcherExecutionStore & RevisionResolutionStore & GitHubEffectStore & ScheduleStore & ObservabilityStore & {
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

export function readPostgresRuntimeStoreOptions(env: NodeJS.ProcessEnv): PostgresRuntimeStoreOptions {
  const connectionString = env.DISPATCH_DATABASE_URL ?? env.DATABASE_URL;
  const host = env.DISPATCH_DATABASE_HOST;
  if (!connectionString && !host) {
    throw new Error("DISPATCH_DATABASE_URL, DATABASE_URL, or DISPATCH_DATABASE_HOST must be set");
  }

  return {
    database: env.DISPATCH_DATABASE_NAME,
    host,
    migrationsFolder: env.DISPATCH_DATABASE_MIGRATIONS_FOLDER,
    password: env.DISPATCH_DATABASE_PASSWORD,
    port: readDatabasePort(env.DISPATCH_DATABASE_PORT),
    user: env.DISPATCH_DATABASE_USER,
    ...(connectionString ? { connectionString } : {}),
    ssl: readBoolean(env.DISPATCH_DATABASE_SSL, false),
    sslRejectUnauthorized: readBoolean(env.DISPATCH_DATABASE_SSL_REJECT_UNAUTHORIZED, false),
  };
}

function readDatabasePort(value: string | undefined): number {
  if (value === undefined || value === "") return 5432;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`DISPATCH_DATABASE_PORT must be a positive integer TCP port at most 65535, got ${value}`);
  }
  return parsed;
}
