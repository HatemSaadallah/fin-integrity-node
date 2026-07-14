import type { FinIntegrityClient } from "./client.js";
import type { EventType } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Wrap the Stripe client you pass in so `charges.create`, `paymentIntents.create`,
 * and `refunds.create` are captured automatically as fin-integrity processor events.
 *
 * We wrap the exact instance you hand us — no global monkey-patching — so it's
 * predictable and ESM/bundler-safe. Capture runs off the hot path and never blocks
 * or alters your Stripe call. Returns the same (now instrumented) client.
 */
export function instrumentStripe<T>(stripe: T, fi: FinIntegrityClient): T {
  const s = stripe as any;
  wrap(s?.charges, "create", fi, "payment");
  wrap(s?.paymentIntents, "create", fi, "payment");
  wrap(s?.refunds, "create", fi, "refund");
  return stripe;
}

function wrap(resource: any, method: string, fi: FinIntegrityClient, type: EventType): void {
  if (!resource || typeof resource[method] !== "function") return;
  const original = resource[method];
  if (original.__fiWrapped) return; // idempotent — never double-wrap

  const wrapped = async function (this: any, ...args: any[]) {
    const result = await original.apply(this, args); // never block/alter the real call
    queueMicrotask(() => {
      try {
        captureStripe(fi, type, result);
      } catch {
        /* swallowed — must never break the Stripe call path */
      }
    });
    return result;
  };
  wrapped.__fiWrapped = true;
  resource[method] = wrapped;
}

function captureStripe(fi: FinIntegrityClient, type: EventType, obj: any): void {
  if (!obj || typeof obj !== "object" || typeof obj.id !== "string") return;
  const amount = type === "refund" ? obj.amount : obj.amount_received ?? obj.amount;
  const reference =
    obj.metadata?.reference ??
    obj.metadata?.order_id ??
    obj.metadata?.reconciliation_id ??
    (type === "refund" ? obj.charge ?? obj.payment_intent ?? obj.id : obj.id);

  fi.capture({
    side: "processor",
    type,
    source: "stripe",
    reference: String(reference),
    external_id: obj.id,
    amount: { minor: typeof amount === "number" ? amount : 0, currency: String(obj.currency ?? "") },
    ...(obj.status ? { status: String(obj.status) } : {}),
    ...(typeof obj.created === "number" ? { occurred_at: new Date(obj.created * 1000) } : {}),
    metadata: { stripe_object: obj.object },
  });
}
