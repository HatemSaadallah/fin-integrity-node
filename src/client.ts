import { cleanEnvironment } from "./environment.js";
import { ConfigError, FinIntegrityError } from "./errors.js";
import { deterministicKey, uuidKey } from "./idempotency.js";
import { HttpTransport, MemoryTransport } from "./transport.js";
import type { EventEnvelope, FinIntegrityConfig, PayoutInput, RecordInput, Side, SubscriptionInput, Transport } from "./types.js";

const DEFAULT_ENDPOINT = "https://ingest.fin-integrity.com";

export class FinIntegrityClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly idempotencyMode: "deterministic" | "uuid";
  private readonly maxSize: number;
  private readonly flushMs: number;
  private readonly maxQueueSize: number;
  private readonly sampleRate: number;
  private readonly environment?: string;
  private readonly beforeSend?: FinIntegrityConfig["beforeSend"];
  private readonly debug: boolean;
  private readonly onError: (err: unknown) => void;
  private readonly transport: Transport;
  private readonly memory?: MemoryTransport;

  private queue: EventEnvelope[] = [];
  private dropped = 0;
  private timer?: ReturnType<typeof setInterval>;

  /** Capture money-movement observed from a payment processor (Stripe, Adyen, bank, …). */
  readonly processor: {
    record: (input: RecordInput) => void;
    recordPayout: (input: PayoutInput) => void;
    recordSubscription: (input: SubscriptionInput) => void;
  };
  /** Capture entries from your own internal ledger / books. */
  readonly ledger: { record: (input: RecordInput) => void };

  constructor(config: FinIntegrityConfig = {}) {
    const dryRun = config.dryRun ?? false;
    const apiKey = config.apiKey ?? process.env.FIN_INTEGRITY_KEY;
    if (!apiKey && !dryRun && !config.transport) {
      throw new ConfigError(
        "fin-integrity: apiKey is required (pass config.apiKey or set FIN_INTEGRITY_KEY). Use { dryRun: true } to test without a key.",
      );
    }
    this.apiKey = apiKey ?? "dry-run";
    this.endpoint = config.endpoint ?? process.env.FIN_INTEGRITY_ENDPOINT ?? DEFAULT_ENDPOINT;
    this.idempotencyMode = config.idempotency ?? "deterministic";
    this.maxSize = config.batch?.maxSize ?? 50;
    this.flushMs = config.batch?.flushMs ?? 2000;
    this.maxQueueSize = config.maxQueueSize ?? 1000;
    this.sampleRate = config.sampleRate ?? 1.0;
    this.environment = cleanEnvironment(config.environment ?? process.env.NODE_ENV);
    this.beforeSend = config.beforeSend;
    this.debug = config.debug ?? false;
    this.onError = config.onError ?? ((e) => { if (this.debug) console.warn("[fin-integrity]", e); });

    if (config.transport) {
      this.transport = config.transport;
    } else if (dryRun) {
      this.memory = new MemoryTransport();
      this.transport = this.memory;
    } else {
      this.transport = new HttpTransport({
        endpoint: this.endpoint,
        apiKey: this.apiKey,
        retries: config.retries ?? 3,
        debug: this.debug,
      });
    }

    this.processor = {
      record: (input) => this.record("processor", input),
      recordPayout: (input) => this.recordPayout(input),
      recordSubscription: (input) => this.recordSubscription(input),
    };
    this.ledger = { record: (input) => this.record("ledger", input) };

    this.timer = setInterval(() => void this.flush(), this.flushMs);
    if (typeof this.timer.unref === "function") this.timer.unref();

    process.once("beforeExit", () => void this.flush());
    process.once("SIGTERM", () => this.onSigterm());
  }

  /**
   * Drain on SIGTERM, then hand the process back its normal fate.
   *
   * Node disables its default terminate-on-SIGTERM as soon as ANY listener is
   * registered, so simply attaching one made this library silently decide that
   * SIGTERM no longer kills the host process — a bare script would ignore
   * `docker stop` and hang until SIGKILL, which is also when the queued events
   * we were trying to protect get dropped anyway.
   *
   * So: flush, then exit ourselves — but only if nothing else is listening. If
   * the app registered its own handler it owns the shutdown sequence, and a
   * library must not exit out from under it. `once` has already removed our own
   * listener by the time this runs, so any remaining count is the app's.
   */
  private onSigterm(): void {
    const appHandlesIt = process.listenerCount("SIGTERM") > 0;
    void this.flush().finally(() => {
      if (!appHandlesIt) process.exit(143); // 128 + SIGTERM(15), the conventional code
    });
  }

  /** Low-level escape hatch: capture a fully-specified event (both adapters use this). */
  capture(input: RecordInput & { side: Side }): void {
    this.record(input.side, input);
  }

  private record(side: Side, input: RecordInput): void {
    try {
      const env: EventEnvelope = {
        schema_version: "1.0",
        event_id: uuidKey(),
        idempotency_key: "",
        side,
        source: input.source ?? (side === "ledger" ? "ledger.internal" : "custom"),
        event_type: input.type,
        reference: input.reference,
        external_id: input.external_id,
        amount: {
          minor: toMinorString(input.amount.minor),
          currency: input.amount.currency.toLowerCase(),
          ...(input.amount.exponent != null ? { exponent: input.amount.exponent } : {}),
        },
        ...(input.fee != null
          ? { fee: { minor: toMinorString(input.fee.minor), currency: input.fee.currency.toLowerCase() } }
          : {}),
        ...(input.traceId != null ? { trace_id: input.traceId } : {}),
        ...(input.payoutId != null ? { payout_id: input.payoutId } : {}),
        ...(input.subscriptionId != null ? { subscription_id: input.subscriptionId } : {}),
        ...(input.parentExternalId != null ? { parent_external_id: input.parentExternalId } : {}),
        occurred_at: toIso(input.occurred_at),
        captured_at: new Date().toISOString(),
        ...(input.status != null ? { status: input.status } : {}),
        ...(input.direction != null ? { direction: input.direction } : {}),
        ...this.envFields(input.environment),
        ...(input.metadata != null ? { metadata: input.metadata } : {}),
      };
      env.idempotency_key = this.idempotencyMode === "uuid" ? uuidKey() : deterministicKey(env);
      this.enqueue(env);
    } catch (err) {
      this.onError(err); // fail-open — never throw into the caller
    }
  }

  /**
   * Capture a recurring billing container. Not money movement — this is what a
   * charge is expected to arrive in, which is what lets reconciliation catch a
   * billing period that produced no charge at all.
   *
   * Send it whenever the subscription changes (created, renewed, status change)
   * so `currentPeriodEnd` stays current.
   */
  private recordSubscription(input: SubscriptionInput): void {
    try {
      const env: EventEnvelope = {
        schema_version: "1.0",
        event_id: uuidKey(),
        idempotency_key: "",
        side: "processor",
        source: input.source ?? "custom",
        event_type: "subscription",
        reference: input.external_id,
        external_id: input.external_id,
        amount: {
          minor: toMinorString(input.amount.minor),
          currency: input.amount.currency.toLowerCase(),
          ...(input.amount.exponent != null ? { exponent: input.amount.exponent } : {}),
        },
        status: input.status,
        ...(input.interval != null ? { interval: input.interval } : {}),
        ...(input.currentPeriodStart != null ? { current_period_start: toIso(input.currentPeriodStart) } : {}),
        ...(input.currentPeriodEnd != null ? { current_period_end: toIso(input.currentPeriodEnd) } : {}),
        ...(input.traceId != null ? { trace_id: input.traceId } : {}),
        occurred_at: toIso(input.occurred_at),
        captured_at: new Date().toISOString(),
        ...this.envFields(input.environment),
        ...(input.metadata != null ? { metadata: input.metadata } : {}),
      };
      env.idempotency_key = this.idempotencyMode === "uuid" ? uuidKey() : deterministicKey(env);
      this.enqueue(env);
    } catch (err) {
      this.onError(err); // fail-open
    }
  }

  /** Capture a processor payout (processor → bank). Stored separately; links to
   *  transactions via their payoutId. */
  private recordPayout(input: PayoutInput): void {
    try {
      const env: EventEnvelope = {
        schema_version: "1.0",
        event_id: uuidKey(),
        idempotency_key: "",
        side: "processor",
        source: input.source ?? "custom",
        event_type: "payout",
        reference: input.external_id,
        external_id: input.external_id,
        amount: {
          minor: toMinorString(input.amount.minor),
          currency: input.amount.currency.toLowerCase(),
          ...(input.amount.exponent != null ? { exponent: input.amount.exponent } : {}),
        },
        ...(input.traceId != null ? { trace_id: input.traceId } : {}),
        ...(input.arrivalAt != null ? { arrival_at: toIso(input.arrivalAt) } : {}),
        occurred_at: toIso(input.occurred_at),
        captured_at: new Date().toISOString(),
        ...(input.status != null ? { status: input.status } : {}),
        ...this.envFields(input.environment),
        ...(input.metadata != null ? { metadata: input.metadata } : {}),
      };
      env.idempotency_key = this.idempotencyMode === "uuid" ? uuidKey() : deterministicKey(env);
      this.enqueue(env);
    } catch (err) {
      this.onError(err); // fail-open
    }
  }

  /** Per-event override wins over the client default; an invalid value falls back
   *  to the default (and, if that's absent too, the server defaults to production). */
  private envFields(perEvent?: string): { environment?: string } {
    const environment = cleanEnvironment(perEvent) ?? this.environment;
    return environment != null ? { environment } : {};
  }

  private enqueue(env: EventEnvelope): void {
    if (this.sampleRate < 1 && Math.random() > this.sampleRate) return;
    let out: EventEnvelope | null | undefined = env;
    if (this.beforeSend) out = this.beforeSend(env);
    if (!out) return;
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift(); // drop-oldest
      this.dropped++;
    }
    this.queue.push(out);
    if (this.queue.length >= this.maxSize) void this.flush();
  }

  /** Send all queued events now. Safe to await (e.g. in a serverless `finally`). */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const dropped = this.dropped;
    this.dropped = 0;
    try {
      await this.transport.send(batch, { dropped });
    } catch (err) {
      this.onError(err); // fail-open: batch is lost, SDK stays alive
    }
  }

  /** Drain and stop the client (call before a long-lived process exits). */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  /** Record a deploy marker so reconciliation can attribute a discrepancy spike
   *  to the release that caused it. Infrequent; sent directly (not batched).
   *  Fail-open — never throws into your deploy pipeline. */
  async recordDeploy(
    release: string,
    opts: { environment?: string; deployedAt?: string | Date } = {},
  ): Promise<void> {
    try {
      const clean = cleanReleaseLabel(release);
      if (!clean) return;
      const body: Record<string, unknown> = { release: clean, source: "sdk" };
      if (opts.environment != null) body.environment = opts.environment;
      if (opts.deployedAt != null) {
        body.deployed_at = opts.deployedAt instanceof Date ? opts.deployedAt.toISOString() : String(opts.deployedAt);
      }
      const res = await fetch(this.endpoint.replace(/\/+$/, "") + "/v1/deploys", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`fin-integrity: recordDeploy got ${res.status}`);
    } catch (err) {
      this.onError(err);  // fail-open
    }
  }

  /** Envelopes captured so far (dryRun / MemoryTransport only). Great for tests. */
  inspect(): EventEnvelope[] {
    return this.memory ? [...this.memory.sent, ...this.queue] : [...this.queue];
  }
}

function toMinorString(m: number | bigint): string {
  if (typeof m === "bigint") return m.toString();
  if (!Number.isInteger(m)) {
    throw new FinIntegrityError(`amount.minor must be an integer in minor units, got ${m}`);
  }
  return String(m);
}
function toIso(v?: string | Date): string {
  if (!v) return new Date().toISOString();
  return v instanceof Date ? v.toISOString() : v;
}
function cleanReleaseLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v || v.length > 200 || /[\n\t]/.test(v)) return undefined;
  return v;
}
