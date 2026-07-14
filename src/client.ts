import { ConfigError, FinIntegrityError } from "./errors.js";
import { deterministicKey, uuidKey } from "./idempotency.js";
import { HttpTransport, MemoryTransport } from "./transport.js";
import type { EventEnvelope, FinIntegrityConfig, RecordInput, Side, Transport } from "./types.js";

const DEFAULT_ENDPOINT = "https://ingest.fin-integrity.com";

export class FinIntegrityClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly idempotencyMode: "deterministic" | "uuid";
  private readonly maxSize: number;
  private readonly flushMs: number;
  private readonly maxQueueSize: number;
  private readonly sampleRate: number;
  private readonly beforeSend?: FinIntegrityConfig["beforeSend"];
  private readonly debug: boolean;
  private readonly onError: (err: unknown) => void;
  private readonly transport: Transport;
  private readonly memory?: MemoryTransport;

  private queue: EventEnvelope[] = [];
  private dropped = 0;
  private timer?: ReturnType<typeof setInterval>;

  /** Capture money-movement observed from a payment processor (Stripe, Adyen, bank, …). */
  readonly processor: { record: (input: RecordInput) => void };
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

    this.processor = { record: (input) => this.record("processor", input) };
    this.ledger = { record: (input) => this.record("ledger", input) };

    this.timer = setInterval(() => void this.flush(), this.flushMs);
    if (typeof this.timer.unref === "function") this.timer.unref();

    const drain = () => void this.flush();
    process.once("beforeExit", drain);
    process.once("SIGTERM", drain);
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
        occurred_at: toIso(input.occurred_at),
        captured_at: new Date().toISOString(),
        ...(input.status != null ? { status: input.status } : {}),
        ...(input.direction != null ? { direction: input.direction } : {}),
        ...(input.metadata != null ? { metadata: input.metadata } : {}),
      };
      env.idempotency_key = this.idempotencyMode === "uuid" ? uuidKey() : deterministicKey(env);
      this.enqueue(env);
    } catch (err) {
      this.onError(err); // fail-open — never throw into the caller
    }
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
