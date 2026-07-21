export type Side = "processor" | "ledger";
/** Money movement. A dispute is money leaving against a charge — same shape as a
 *  refund, so it reconciles through the same path. */
export type EventType = "payment" | "refund" | "dispute";
/** Wire-level event types. `payout` and `subscription` are processor-only and
 *  land in their own tables. */
export type WireEventType = EventType | "payout" | "subscription";
export type Direction = "credit" | "debit";

/** Money as an integer count of the currency's minor units + ISO-4217 code. Never a float. */
export interface Money {
  /** Integer minor units (e.g. 4999 = $49.99). Accepts number or bigint; serialized as a string. */
  minor: number | bigint;
  /** ISO-4217 currency code, lowercased (e.g. "usd", "jpy"). */
  currency: string;
  /** Optional minor-unit exponent for zero/three-decimal or custom currencies. */
  exponent?: number;
}

/** The wire envelope sent to the ingest API. CloudEvents-shaped. */
export interface EventEnvelope {
  schema_version: "1.0";
  event_id: string;
  idempotency_key: string;
  side: Side;
  source: string;
  event_type: WireEventType;
  /** The cross-side join key both sides agree on. */
  reference: string;
  /** This side's native id (e.g. Stripe pi_…/re_…, a ledger row id). */
  external_id: string;
  amount: { minor: string; currency: string; exponent?: number };
  /** Processor fee (minor units); lets reconciliation match a net-of-fee ledger entry. */
  fee?: { minor: string; currency: string };
  /** Correlation id threading the whole transaction journey (frontend → db). */
  trace_id?: string;
  /** The payout this transaction settled in (processor side). */
  payout_id?: string;
  /** The subscription a charge belongs to (processor side). */
  subscription_id?: string;
  /** The charge a refund/dispute acts on. */
  parent_external_id?: string;
  /** Payout arrival time (payout events only). */
  arrival_at?: string;
  /** Subscription fields (subscription events only). */
  interval?: string;
  current_period_start?: string;
  current_period_end?: string;
  occurred_at: string;
  captured_at: string;
  status?: string;
  direction?: Direction;
  /** Free-form environment tag (Sentry-style). Reconciliation segments by it, so
   *  events tagged `staging` never match a `production` ledger. */
  environment?: string;
  metadata?: Record<string, unknown>;
}

/** Ergonomic input for record(); the client builds the envelope from it. */
export interface RecordInput {
  type: EventType;
  /** Origin system. Defaults to "custom" (processor) / "ledger.internal" (ledger). */
  source?: string;
  reference: string;
  external_id: string;
  amount: Money;
  /** Processor fee (minor units) — enables net-of-fee reconciliation. */
  fee?: Money;
  /** Correlation id for end-to-end tracing. Reuse the one from the frontend SDK. */
  traceId?: string;
  /** Link this transaction to the payout it settles in. */
  payoutId?: string;
  /** The subscription this charge belongs to (sub_…). Lets reconciliation spot a
   *  billing period that never produced a charge. */
  subscriptionId?: string;
  /** The charge a refund or dispute acts on. */
  parentExternalId?: string;
  occurred_at?: string | Date;
  /** For disputes: needs_response | under_review | won | lost. Only `lost` is
   *  settled money-out. */
  status?: string;
  direction?: Direction;
  /** Override the client's default environment for this one event. */
  environment?: string;
  metadata?: Record<string, unknown>;
}

/** Input for recordSubscription() — a recurring billing container, not money. */
export interface SubscriptionInput {
  source?: string;
  /** The processor's subscription id (e.g. Stripe sub_…). */
  external_id: string;
  status: "active" | "past_due" | "canceled" | "paused" | "trialing";
  /** Amount billed each period. */
  amount: Money;
  interval?: "day" | "week" | "month" | "year";
  currentPeriodStart?: string | Date;
  /** When the next charge is expected by. Reconciliation flags a live
   *  subscription whose period ended with no charge. */
  currentPeriodEnd?: string | Date;
  traceId?: string;
  occurred_at?: string | Date;
  /** Override the client's default environment for this one event. */
  environment?: string;
  metadata?: Record<string, unknown>;
}

/** Input for recordPayout() — a processor payout (processor → bank). */
export interface PayoutInput {
  source?: string;
  /** The processor's payout id (e.g. Stripe po_…). Used as the reference + external id. */
  external_id: string;
  amount: Money;
  /** When the funds are expected to (or did) arrive in the bank. */
  arrivalAt?: string | Date;
  traceId?: string;
  occurred_at?: string | Date;
  status?: string;
  /** Override the client's default environment for this one event. */
  environment?: string;
  metadata?: Record<string, unknown>;
}

/** Pluggable transport (swap for tests or custom delivery). */
export interface Transport {
  send(batch: EventEnvelope[], meta: { dropped: number }): Promise<void>;
}

export interface FinIntegrityConfig {
  /** Secret key (fi_sk_live_… / fi_sk_test_…). Falls back to env FIN_INTEGRITY_KEY. */
  apiKey?: string;
  /** Ingest base URL. Falls back to env FIN_INTEGRITY_ENDPOINT, then the hosted default. */
  endpoint?: string;
  /** Tag events with an environment. Defaults to NODE_ENV. */
  environment?: string;
  /** How idempotency keys are generated. Default "deterministic" (content hash). */
  idempotency?: "deterministic" | "uuid";
  /** Batching controls. */
  batch?: { maxSize?: number; flushMs?: number };
  /** Max queued events before drop-oldest kicks in. Default 1000. */
  maxQueueSize?: number;
  /** Network retry attempts on 5xx/429/network errors. Default 3. */
  retries?: number;
  /** Fraction of events to keep, [0,1]. Default 1.0 — never silently drop money events. */
  sampleRate?: number;
  /** Mutate or drop (return null) each envelope before sending — e.g. redact PII. */
  beforeSend?: (e: EventEnvelope) => EventEnvelope | null | undefined;
  /** Log transport activity. Default false. */
  debug?: boolean;
  /** Build + validate envelopes but never hit the network. Inspect via _inspect(). */
  dryRun?: boolean;
  /** Override the transport (e.g. an in-memory transport in tests). */
  transport?: Transport;
  /** Called on any internal/transport error. The SDK never throws into your code. */
  onError?: (err: unknown) => void;
}
