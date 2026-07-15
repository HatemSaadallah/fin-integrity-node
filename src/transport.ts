import { FinIntegrityError } from "./errors.js";
import type { EventEnvelope, Transport } from "./types.js";

export interface HttpTransportOptions {
  endpoint: string;
  apiKey: string;
  retries: number;
  debug: boolean;
}

/** Batched HTTP transport. Retries 5xx/429/network with backoff; honors Retry-After. */
export class HttpTransport implements Transport {
  constructor(private readonly opts: HttpTransportOptions) {}

  async send(batch: EventEnvelope[], meta: { dropped: number }): Promise<void> {
    const url = this.opts.endpoint.replace(/\/+$/, "") + "/v1/events";
    const body = JSON.stringify({ sent_at: new Date().toISOString(), dropped: meta.dropped, events: batch });

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.apiKey}`,
            "idempotency-key": batch[0]?.idempotency_key ?? "",
          },
          body,
        });
      } catch (netErr) {
        if (attempt >= this.opts.retries) throw netErr;
        await sleep(backoff(attempt));
        continue;
      }

      if (res.ok) {
        // A 200 means the batch was received, NOT that every event was stored:
        // ingest validates per event and reports rejects in the body. Treating
        // 200 as total success hides dropped money events behind a success log.
        const rejected = await rejectedFrom(res);
        if (rejected.length > 0) {
          throw new RejectedEventsError(rejected, batch.length);
        }
        if (this.opts.debug) console.log(`[fin-integrity] delivered ${batch.length} event(s)`);
        return;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.opts.retries) throw new Error(`fin-integrity ingest ${res.status}`);
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
        continue;
      }
      // 4xx — terminal, do not retry
      throw new Error(`fin-integrity ingest ${res.status}: ${await safeText(res)}`);
    }
  }
}

/** In-memory transport for dryRun and tests. */
export class MemoryTransport implements Transport {
  sent: EventEnvelope[] = [];
  async send(batch: EventEnvelope[]): Promise<void> {
    this.sent.push(...batch);
  }
}

function backoff(n: number): number {
  return Math.min(1000 * 2 ** n, 15000) + Math.random() * 250;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/** Per-event rejections inside an HTTP 200. Surfaced via onError, never thrown to the caller. */
export class RejectedEventsError extends FinIntegrityError {
  constructor(
    readonly rejected: RejectedEvent[],
    readonly batchSize: number,
  ) {
    const detail = rejected.map((r) => `${r.event_id}: ${r.error}`).join("; ");
    super(`fin-integrity: ingest rejected ${rejected.length}/${batchSize} event(s) — ${detail}`);
    this.name = "RejectedEventsError";
  }
}

export interface RejectedEvent {
  event_id: string;
  error: string;
}

/** Rejected entries from a 200 body. An unparseable body means nothing to report. */
async function rejectedFrom(res: Response): Promise<RejectedEvent[]> {
  try {
    const body = (await res.clone().json()) as {
      results?: Array<{ event_id?: string; status?: string; error?: string }>;
    };
    if (!Array.isArray(body?.results)) return [];
    return body.results
      .filter((r) => r?.status === "rejected")
      .map((r) => ({ event_id: r.event_id ?? "unknown", error: r.error ?? "unknown error" }));
  } catch {
    return [];
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
