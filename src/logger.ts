/**
 * Minimal structured JSON logger.
 *
 * Each line written to stdout is a single JSON object:
 *   { "time": "<ISO8601>", "level": "<level>", "msg": "<message>", ...context }
 *
 * Log level is controlled by the LOG_LEVEL environment variable
 * (debug | info | warn | error). Defaults to "info".
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

export type Logger = {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
};

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function parseLevel(raw: string | undefined): LogLevel {
  const lower = raw?.toLowerCase();
  if (lower === "debug" || lower === "info" || lower === "warn" || lower === "error") return lower;
  return "info";
}

const minLevel = parseLevel(process.env.LOG_LEVEL);

function createLogger(baseCtx: LogContext = {}): Logger {
  function write(level: LogLevel, msg: string, ctx: LogContext = {}): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    process.stdout.write(
      JSON.stringify({ time: new Date().toISOString(), level, msg, ...baseCtx, ...ctx }) + "\n",
    );
  }

  return {
    debug: (msg, ctx) => write("debug", msg, ctx),
    info:  (msg, ctx) => write("info",  msg, ctx),
    warn:  (msg, ctx) => write("warn",  msg, ctx),
    error: (msg, ctx) => write("error", msg, ctx),
    child: (ctx) => createLogger({ ...baseCtx, ...ctx }),
  };
}

/**
 * Application-wide logger instance.
 * Import this directly in any module that needs to log.
 */
export const logger: Logger = createLogger();

/**
 * Serialize an unknown caught value into a plain object suitable for
 * inclusion as an `err` field in a log context.
 *
 * @example
 * logger.error("thing failed", { err: toErrCtx(error) });
 */
export function toErrCtx(error: unknown): LogContext {
  if (error instanceof Error) {
    return { message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { message: String(error) };
}
