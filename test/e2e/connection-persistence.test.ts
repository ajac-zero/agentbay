import { randomUUID } from "node:crypto";
import pg from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionAlreadyExistsError, ConnectionNotFoundError } from "../../src/connection/index.js";
import { createPostgresRuntimeStore, type PostgresRuntimeStore } from "../../src/runtime/postgres.js";

const { Pool } = pg;

describe("connection persistence", () => {
  let postgres: StartedTestContainer;
  let store: PostgresRuntimeStore;
  let pool: pg.Pool;

  beforeAll(async () => {
    postgres = await startPostgres();
    const connectionString = postgresConnectionString(postgres);
    store = await createPostgresRuntimeStore({
      connectionString,
      runMigrations: true,
      ssl: false,
      sslRejectUnauthorized: false,
    });
    pool = new Pool({ connectionString });
  });

  afterAll(async () => {
    await pool?.end();
    await store?.close();
    await postgres?.stop();
  });

  it("creates and gets tenant-scoped connections", async () => {
    const first = connection("tenant-a", "grafana-readonly", "grafana");
    expect(await store.createConnection(first)).toEqual(first);
    expect(await store.getConnection("tenant-a", "grafana-readonly")).toEqual(first);
    expect(await store.getConnection("tenant-b", "grafana-readonly")).toBeUndefined();

    await expect(store.createConnection(connection("tenant-a", "grafana-readonly", "other")))
      .rejects.toBeInstanceOf(ConnectionAlreadyExistsError);
    const otherTenant = connection("tenant-b", "grafana-readonly", "grafana");
    await expect(store.createConnection(otherTenant)).resolves.toEqual(otherTenant);
  });

  it("rejects malformed direct create commands", async () => {
    const malformed = connection(`tenant-${randomUUID()}`, "Invalid_ID", "grafana");

    await expect(store.createConnection(malformed)).rejects.toThrow();
    expect(await store.getConnection(malformed.tenantId, malformed.connection.id)).toBeUndefined();
  });

  it("rejects corrupt persisted connection rows on read", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const connectionId = "Corrupt_ID";
    await pool.query(`INSERT INTO agentbay_connections (id, tenant_id, connection_id, type, created_at)
      VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), tenantId, connectionId, "grafana", new Date()]);

    await expect(store.getConnection(tenantId, connectionId)).rejects.toThrow();
  });

  it("publishes ordered connection grants atomically", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const grafana = connection(tenantId, "grafana-readonly", "grafana");
    const github = connection(tenantId, "github-production", "github");
    await store.createConnection(grafana);
    await store.createConnection(github);

    const profile = await store.publishProfileVersion(profileCommand(tenantId, "profile-valid", [
      { id: grafana.connection.id, sidecar: "grafana-tools" },
      { id: github.connection.id, sidecar: "github-tools" },
    ]));
    expect((await store.getProfileVersion(tenantId, "profile-valid", 1))?.definition.connections)
      .toEqual(profile.definition.connections);

    const grants = await pool.query(`SELECT grant_row.connection_id, grant_row.sidecar, grant_row.ordinal
      FROM agentbay_agent_profile_version_connections AS grant_row
      WHERE grant_row.profile_version_id = $1 ORDER BY grant_row.ordinal`, [profile.id]);
    expect(grants.rows).toEqual([
      { connection_id: grafana.id, ordinal: 0, sidecar: "grafana-tools" },
      { connection_id: github.id, ordinal: 1, sidecar: "github-tools" },
    ]);
  });

  it.each(["missing", "cross-tenant"])("rolls back a profile with a %s connection", async (kind) => {
    const tenantId = `tenant-${randomUUID()}`;
    const connectionId = `${kind}-connection`;
    if (kind === "cross-tenant") await store.createConnection(connection("other-tenant", connectionId, "grafana"));
    const command = profileCommand(tenantId, `profile-${kind}`, [{ id: connectionId, sidecar: "external-tools" }]);

    await expect(store.publishProfileVersion(command)).rejects.toBeInstanceOf(ConnectionNotFoundError);
    expect(await store.getProfileVersion(tenantId, command.profileId, command.version)).toBeUndefined();
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM agentbay_agent_profile_version_connections WHERE profile_version_id = $1",
      [command.id],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("persists no secret-bearing connection columns", async () => {
    const columns = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agentbay_connections' ORDER BY ordinal_position`);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "connection_id", "created_at", "id", "tenant_id", "type",
    ]);
  });
});

function connection(tenantId: string, connectionId: string, type: string) {
  return {
    connection: { id: connectionId, type },
    createdAt: new Date().toISOString(),
    id: randomUUID(),
    tenantId,
  };
}

function profileCommand(tenantId: string, profileId: string, connections: { id: string; sidecar: string }[]) {
  return {
    createdAt: new Date().toISOString(),
    definition: {
      connections,
      permissions: { onRequest: "fail" as const },
      runtime: { type: "opencode" as const, agent: "coder", opencodeConfig: { agent: { coder: {} } } },
      sandbox: { templateName: "opencode", warmPool: "none" },
      schemaVersion: 1 as const,
      timeoutSeconds: 3_600,
    },
    id: randomUUID(),
    profileId,
    tenantId,
    version: 1,
  };
}

async function startPostgres(): Promise<StartedTestContainer> {
  return new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_DB: "agentbay",
      POSTGRES_PASSWORD: "agentbay-password",
      POSTGRES_USER: "agentbay",
    })
    .withExposedPorts(5432)
    .withHealthCheck({
      interval: 1_000,
      retries: 30,
      test: ["CMD-SHELL", "pg_isready -U agentbay -d agentbay"],
      timeout: 5_000,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
}

function postgresConnectionString(container: StartedTestContainer): string {
  return `postgresql://agentbay:agentbay-password@${container.getHost()}:${container.getMappedPort(5432)}/agentbay`;
}
