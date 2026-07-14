# @fin-integrity/node

**Reconciliation-as-you-code.** Capture your Stripe (and any processor) events _and_ your internal ledger entries from your backend, and fin·integrity continuously matches them — surfacing missing entries, duplicates, missing refunds, and amount/currency mismatches as incidents, in real time.

Think **"Sentry for money movement"**: add a few lines, keep your own ledger, and catch every payment that doesn't reconcile before your customers, finance team, or auditors do.

- 🪶 Tiny, zero-runtime-dependency, dual **ESM + CJS**, fully typed
- 🔌 **Processor-agnostic** core (`processor.record` / `ledger.record`) with a Stripe adapter
- 🧯 **Fail-open by design** — the SDK can never throw into or block your money path
- ⚡ Async, batched, non-blocking capture with graceful serverless flush
- 🔑 Server-side secret keys; you send transaction metadata, never card data

> Status: early (`0.1.x`). The API surface below is stable; internals may change.

## Install

```bash
npm install @fin-integrity/node
# Stripe auto-instrumentation is an optional peer dependency:
npm install stripe
```

## Quickstart

```ts
import Stripe from "stripe";
import { init, instrumentStripe } from "@fin-integrity/node";

const fi = init({ apiKey: process.env.FIN_INTEGRITY_KEY! });

// 1) Auto-capture the processor side by wrapping your Stripe client
const stripe = instrumentStripe(new Stripe(process.env.STRIPE_KEY!), fi);
const charge = await stripe.charges.create({ amount: 4999, currency: "usd", metadata: { reference: "order_10432" } });

// 2) Report the ledger side where you write to your own books
fi.ledger.record({
  type: "payment",
  reference: "order_10432",           // the shared key both sides agree on
  external_id: journalEntry.id,
  amount: { minor: 4999, currency: "usd" },
});

// fin·integrity matches the two by `reference` and flags any mismatch.
```

That's it. Any processor works — for non-Stripe sources, capture the processor side explicitly:

```ts
fi.processor.record({
  type: "payment",
  source: "adyen",
  reference: "order_10432",
  external_id: "8536214598321",
  amount: { minor: 4999, currency: "usd" },
});
```

## The model: two sides, one reference

fin·integrity reconciles two streams:

| Side | What it is | You send it with |
|---|---|---|
| **processor** | The money actually moved (Stripe/Adyen/bank …) | `fi.processor.record(...)` (or `instrumentStripe`) |
| **ledger** | Your internal books / system of record | `fi.ledger.record(...)` |

Both sides carry a shared **`reference`** (an order id, invoice id, whatever both systems agree on). fin·integrity **matches on `reference` + `type`**, then **compares** `amount` and `currency` — so a wrong amount surfaces as an incident instead of silently failing to match.

## Money

Always integer **minor units** + an ISO-4217 currency code — never floats.

```ts
{ minor: 4999, currency: "usd" }   // $49.99
{ minor: 1000, currency: "jpy" }   // ¥1000 (zero-decimal)
{ minor: 10000, currency: "bhd", exponent: 3 } // 10.000 BHD
```

`minor` accepts a `number` or a `bigint` (for very large values). Non-integer amounts are rejected (routed to `onError`, never thrown).

## API

### `init(config?) → FinIntegrityClient`
Creates the client and stores it as a module singleton (also returned).

| Option | Default | Description |
|---|---|---|
| `apiKey` | `env FIN_INTEGRITY_KEY` | Secret key `fi_sk_live_…` / `fi_sk_test_…`. |
| `endpoint` | hosted default | Ingest base URL. Point at your own for self-host/local. |
| `environment` | `NODE_ENV` | Tag events with an environment. |
| `idempotency` | `"deterministic"` | `"deterministic"` (content hash, retry-safe) or `"uuid"`. |
| `batch` | `{ maxSize: 50, flushMs: 2000 }` | Flush on size **or** interval. |
| `maxQueueSize` | `1000` | Bounded queue; oldest events drop first (counted + reported). |
| `retries` | `3` | Network retry attempts (exp backoff; honors `Retry-After`). |
| `sampleRate` | `1.0` | Keep everything by default — never silently drop money events. |
| `beforeSend` | — | Mutate or drop (`return null`) each envelope, e.g. redact PII. |
| `debug` | `false` | Log transport activity. |
| `dryRun` | `false` | Build/validate but never hit the network; inspect via `inspect()`. |
| `onError` | warns in debug | Called on any internal/transport error. The SDK never throws into your code. |

### `fi.processor.record(input)` / `fi.ledger.record(input)`
```ts
interface RecordInput {
  type: "payment" | "refund";
  source?: string;              // e.g. "stripe", "adyen"; defaults per side
  reference: string;            // shared cross-side key
  external_id: string;          // this side's native id
  amount: { minor: number | bigint; currency: string; exponent?: number };
  occurred_at?: string | Date;  // defaults to now
  status?: string;
  direction?: "credit" | "debit";
  metadata?: Record<string, unknown>;
}
```

### `fi.capture(input & { side })`
Low-level escape hatch used by the adapters — full control over `side`.

### `instrumentStripe(stripe, fi) → stripe`
Wraps the **exact Stripe instance you pass in** so `charges.create`, `paymentIntents.create`, and `refunds.create` are captured automatically. No global monkey-patching, so it's ESM/bundler-safe. Capture runs off the hot path and **never blocks or alters your Stripe call**. Set `metadata.reference` on your Stripe calls to control the reconciliation key.

### `await fi.flush()` / `await fi.shutdown()`
`flush()` sends everything queued now. `shutdown()` drains and stops the client. In **serverless**, flush before the function returns:

```ts
export const handler = async (event) => {
  try { return await doWork(event); }
  finally { await fi.flush(); }   // don't let the runtime freeze before the batch sends
};
```

### `fi.inspect() → EventEnvelope[]`
Returns captured envelopes (in `dryRun` or with a custom transport) — the easiest way to **unit-test** that your integration emits the right events, no HTTP mocking:

```ts
const fi = init({ dryRun: true });
placeOrder();
expect(fi.inspect()).toContainEqual(expect.objectContaining({ reference: "order_10432" }));
```

## Reliability & safety

- **Fail-open:** every internal path is wrapped; SDK errors degrade to `onError` + a no-op. Your payment code is never affected.
- **Bounded, observable:** the queue is capped (drop-oldest); dropped counts ride along on the next batch so loss is never silent.
- **Idempotent:** each event carries an `Idempotency-Key`; retries never create duplicate rows. The default deterministic key means even a crash-then-retry collapses to one event.
- **Backpressure-aware:** honors `429` + `Retry-After` instead of retry-storming.

## Security & data

Send **transaction metadata** — ids, amounts, currency, timestamps, status, your own `metadata`. **Do not send card numbers / PANs or secrets.** Use `beforeSend` to redact anything sensitive before it leaves your process. Keys are server-side secrets — never ship them to a browser.

## Local development

Point the SDK at a local ingest endpoint:

```ts
const fi = init({ apiKey: "fi_sk_test_…", endpoint: "http://localhost:3005" });
```

## License

[MIT](./LICENSE) © fin-integrity
