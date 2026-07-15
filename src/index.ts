import { FinIntegrityClient } from "./client.js";
import type { FinIntegrityConfig } from "./types.js";

export { FinIntegrityClient } from "./client.js";
export { instrumentStripe } from "./stripe.js";
export { FinIntegrityError, ConfigError } from "./errors.js";
// Reaches onError whenever a 2xx carries per-event rejections — callers can't
// branch on an error they have no way to import. Python exports it; parity.
export { RejectedEventsError, type RejectedEvent } from "./transport.js";
export type {
  FinIntegrityConfig,
  RecordInput,
  PayoutInput,
  SubscriptionInput,
  EventEnvelope,
  Money,
  Side,
  EventType,
  WireEventType,
  Direction,
  Transport,
} from "./types.js";

let current: FinIntegrityClient | undefined;

/** Create and configure the client. Returns it (also stored as the module singleton). */
export function init(config?: FinIntegrityConfig): FinIntegrityClient {
  current = new FinIntegrityClient(config);
  return current;
}

/** The client from the most recent init() — convenient in scripts. */
export function getClient(): FinIntegrityClient {
  if (!current) throw new Error("fin-integrity: call init() before getClient()");
  return current;
}
