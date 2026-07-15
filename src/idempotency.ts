import { createHash, randomUUID } from "node:crypto";
import type { EventEnvelope } from "./types.js";

type KeyBasis = Pick<EventEnvelope, "source" | "side" | "external_id" | "event_type"> &
  Partial<Pick<EventEnvelope, "status" | "current_period_end" | "arrival_at">> & {
    amount?: { minor: string };
  };

/**
 * Deterministic content-hash key so a client crash/retry of the *same* underlying
 * fact collapses to one row.
 *
 * The basis is identity + observed state. Identity alone is not enough: the
 * server dedupes on this key and drops the event before it can update anything,
 * so any field that legitimately changes over an entity's life must be in here
 * or the update is silently lost. That bites the states that matter most — a
 * dispute going needs_response -> lost (only `lost` is money out), a
 * subscription renewing into its next period, a payout going pending -> paid.
 *
 * Retry safety is preserved: same fact in the same state = same key = collapsed.
 * A real change produces a new key, reaches the server, and upserts the row.
 */
export function deterministicKey(e: KeyBasis): string {
  const basis = [
    e.source,
    e.side,
    e.external_id,
    e.event_type,
    // Mutable state. Absent fields collapse to "" so unused ones cost nothing.
    e.status ?? "",
    e.amount?.minor ?? "",
    e.current_period_end ?? "",
    e.arrival_at ?? "",
  ].join(":");
  return "fi_" + createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

export function uuidKey(): string {
  return "fi_" + randomUUID();
}
