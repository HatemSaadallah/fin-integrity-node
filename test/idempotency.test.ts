import { describe, it, expect, vi } from "vitest";
import { FinIntegrityClient } from "../src/client.js";
import { HttpTransport } from "../src/transport.js";
import type { EventEnvelope, Transport } from "../src/types.js";

class Capture implements Transport {
  sent: EventEnvelope[] = [];
  async send(batch: EventEnvelope[]): Promise<void> {
    this.sent.push(...batch);
  }
}

const keyOf = (e: EventEnvelope) => e.idempotency_key;

describe("idempotency key basis", () => {
  it("collapses a retry of the same fact in the same state", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 10 } });
    const charge = {
      type: "payment" as const, source: "stripe", reference: "order_1",
      external_id: "ch_1", amount: { minor: 4999, currency: "usd" }, status: "succeeded",
    };
    fi.processor.record(charge);
    fi.processor.record(charge);
    await fi.flush();
    expect(keyOf(t.sent[0]!)).toBe(keyOf(t.sent[1]!));
  });

  it("gives a dispute a new key when it settles, so needs_response -> lost reaches the server", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 10 } });
    const base = {
      type: "dispute" as const, source: "stripe", reference: "dp_1",
      external_id: "dp_1", amount: { minor: 6000, currency: "usd" },
    };
    fi.processor.record({ ...base, status: "needs_response" });
    fi.processor.record({ ...base, status: "lost" });
    await fi.flush();
    // Same key here would mean the loss is deduped away and never booked.
    expect(keyOf(t.sent[0]!)).not.toBe(keyOf(t.sent[1]!));
  });

  it("gives a subscription a new key when its period advances", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 10 } });
    const base = {
      external_id: "sub_1", source: "stripe", status: "active" as const,
      interval: "month" as const, amount: { minor: 2999, currency: "usd" },
    };
    fi.processor.recordSubscription({ ...base, currentPeriodEnd: "2026-08-01T00:00:00Z" });
    fi.processor.recordSubscription({ ...base, currentPeriodEnd: "2026-09-01T00:00:00Z" });
    await fi.flush();
    expect(keyOf(t.sent[0]!)).not.toBe(keyOf(t.sent[1]!));
  });

  it("gives a subscription a new key when its status changes", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 10 } });
    const base = {
      external_id: "sub_1", source: "stripe", amount: { minor: 2999, currency: "usd" },
      currentPeriodEnd: "2026-08-01T00:00:00Z",
    };
    fi.processor.recordSubscription({ ...base, status: "active" });
    fi.processor.recordSubscription({ ...base, status: "past_due" });
    await fi.flush();
    expect(keyOf(t.sent[0]!)).not.toBe(keyOf(t.sent[1]!));
  });

  it("gives a payout a new key when it lands", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 10 } });
    const base = { external_id: "po_1", source: "stripe", amount: { minor: 100_00, currency: "usd" } };
    fi.processor.recordPayout({ ...base, status: "pending" });
    fi.processor.recordPayout({ ...base, status: "paid" });
    await fi.flush();
    expect(keyOf(t.sent[0]!)).not.toBe(keyOf(t.sent[1]!));
  });
});

describe("HttpTransport", () => {
  const envelope = () => [{ event_id: "e1", idempotency_key: "k1" } as EventEnvelope];

  it("reports per-event rejections hidden inside a 200", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          accepted: 0, rejected: 1,
          results: [{ event_id: "e1", status: "rejected", error: 'invalid input value for enum ...: "lost"' }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const t = new HttpTransport({ endpoint: "http://x", apiKey: "k", retries: 0, debug: false });
    // A silent success here is a dropped money event the merchant never hears about.
    await expect(t.send(envelope(), { dropped: 0 })).rejects.toThrow(/rejected 1\/1/);
    vi.unstubAllGlobals();
  });

  it("stays quiet when a 200 accepts everything", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ accepted: 1, rejected: 0, results: [{ event_id: "e1", status: "accepted" }] }),
        { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const t = new HttpTransport({ endpoint: "http://x", apiKey: "k", retries: 0, debug: false });
    await expect(t.send(envelope(), { dropped: 0 })).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("SIGTERM handling", () => {
  // Node disables its default terminate-on-SIGTERM the moment any listener
  // exists, so a library that attaches one silently makes SIGTERM non-fatal for
  // its host — a bare script would ignore `docker stop` and hang until SIGKILL.
  it("exits the process itself when nothing else listens for SIGTERM", async () => {
    const t = new Capture();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 99 } });
    fi.processor.record({ type: "payment", source: "s", reference: "r", external_id: "e", amount: { minor: 1, currency: "usd" } });
    process.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    expect(t.sent).toHaveLength(1);        // drained before dying
    expect(exit).toHaveBeenCalledWith(143); // 128 + SIGTERM
    exit.mockRestore();
    await fi.shutdown();
  });

  it("leaves the exit to the app when the app has its own SIGTERM handler", async () => {
    const t = new Capture();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const appHandler = vi.fn();
    process.on("SIGTERM", appHandler);
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 99 } });
    fi.processor.record({ type: "payment", source: "s", reference: "r", external_id: "e2", amount: { minor: 1, currency: "usd" } });
    process.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    expect(t.sent).toHaveLength(1);   // still drains
    expect(exit).not.toHaveBeenCalled(); // but does not exit out from under the app
    process.off("SIGTERM", appHandler);
    exit.mockRestore();
    await fi.shutdown();
  });
});
