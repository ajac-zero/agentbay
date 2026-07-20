import { logger } from "../logger.js";
import type { OutboxPublisher } from "./publisher.js";

export async function runOutboxPublisherLoop(options: {
  publisher: OutboxPublisher;
  idlePollMs: number;
  signal: AbortSignal;
}): Promise<void> {
  while (!options.signal.aborted) {
    let worked = false;
    try {
      const result = await options.publisher.publishAvailable(options.signal);
      worked = result.claimed > 0;
    } catch (error) {
      if (options.signal.aborted) break;
      logger.error("outbox publisher iteration failed", { error: String(error) });
    }
    if (!worked && !options.signal.aborted) await delay(options.idlePollMs, options.signal);
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
