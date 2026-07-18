export type Connection = {
  readonly id: string;
  readonly tenantId: string;
  readonly connection: {
    readonly id: string;
    readonly type: string;
  };
  readonly createdAt: string;
};

export type CreateConnectionCommand = Connection;

export function parseConnection(value: unknown): Connection {
  return connectionSchema.parse(value);
}

export interface ConnectionStore {
  createConnection(command: CreateConnectionCommand): Promise<Connection>;
  getConnection(tenantId: string, connectionId: string): Promise<Connection | undefined>;
}

export class ConnectionAlreadyExistsError extends Error {
  readonly code = "CONNECTION_ALREADY_EXISTS";

  constructor(connectionId: string) {
    super(`Connection ${connectionId} already exists`);
    this.name = "ConnectionAlreadyExistsError";
  }
}

export class ConnectionNotFoundError extends Error {
  readonly code = "CONNECTION_NOT_FOUND";

  constructor(connectionId: string) {
    super(`Connection ${connectionId} was not found`);
    this.name = "ConnectionNotFoundError";
  }
}
import { z } from "zod";

const connectionIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/);
const connectionTypeSchema = z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);

export const connectionSchema = z.object({
  id: z.uuid(),
  tenantId: connectionIdSchema,
  connection: z.object({ id: connectionIdSchema, type: connectionTypeSchema }).strict(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();
