import { createHash, randomUUID } from "node:crypto";
import type { EventEnvelope } from "./types.js";

/**
 * Deterministic content-hash key so a client crash/retry of the *same* underlying
 * fact collapses to one row. Derived only from stable identity fields.
 */
export function deterministicKey(e: Pick<EventEnvelope, "source" | "side" | "external_id" | "event_type">): string {
  const basis = `${e.source}:${e.side}:${e.external_id}:${e.event_type}`;
  return "fi_" + createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

export function uuidKey(): string {
  return "fi_" + randomUUID();
}
