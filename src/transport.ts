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
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
