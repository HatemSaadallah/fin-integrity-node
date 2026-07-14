import { describe, it, expect, vi } from "vitest";
import { FinIntegrityClient } from "../src/client.js";
import { instrumentStripe } from "../src/stripe.js";
import type { EventEnvelope, Transport } from "../src/types.js";

class Capture implements Transport {
  sent: EventEnvelope[] = [];
  async send(batch: EventEnvelope[]): Promise<void> {
    this.sent.push(...batch);
  }
}

describe("FinIntegrityClient", () => {
  it("builds a processor envelope with money in minor units", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 1 } });
    fi.processor.record({ type: "payment", source: "stripe", reference: "order_1", external_id: "ch_1", amount: { minor: 4999, currency: "USD" } });
    await fi.flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      side: "processor",
      event_type: "payment",
      reference: "order_1",
      external_id: "ch_1",
      amount: { minor: "4999", currency: "usd" },
    });
    expect(t.sent[0]!.idempotency_key).toContain("fi_");
  });

  it("deterministic idempotency key is stable for the same fact", () => {
    const fi = new FinIntegrityClient({ dryRun: true });
    fi.processor.record({ type: "payment", source: "stripe", reference: "o1", external_id: "ch_9", amount: { minor: 100, currency: "usd" } });
    fi.processor.record({ type: "payment", source: "stripe", reference: "o1", external_id: "ch_9", amount: { minor: 100, currency: "usd" } });
    const [a, b] = fi.inspect();
    expect(a!.idempotency_key).toBe(b!.idempotency_key);
  });

  it("supports bigint amounts", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 1 } });
    fi.ledger.record({ type: "payment", reference: "o2", external_id: "je_2", amount: { minor: 9007199254740993n, currency: "usd" } });
    await fi.flush();
    expect(t.sent[0]!.amount.minor).toBe("9007199254740993");
  });

  it("rejects non-integer amounts via onError, never throws", () => {
    const onError = vi.fn();
    const fi = new FinIntegrityClient({ dryRun: true, onError });
    expect(() =>
      fi.processor.record({ type: "payment", reference: "o", external_id: "x", amount: { minor: 10.5, currency: "usd" } }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it("instrumentStripe captures a charge without altering the return value", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t });
    const stripe = {
      charges: {
        create: async () => ({ id: "ch_42", object: "charge", amount: 2000, currency: "usd", status: "succeeded", created: 1720000000, metadata: {} }),
      },
    };
    const wrapped = instrumentStripe(stripe as never, fi) as typeof stripe;
    const charge = await wrapped.charges.create();
    expect(charge.id).toBe("ch_42"); // original return preserved
    await new Promise((r) => setTimeout(r, 10)); // let queueMicrotask capture run
    await fi.flush();
    expect(t.sent[0]).toMatchObject({ side: "processor", source: "stripe", external_id: "ch_42", amount: { minor: "2000", currency: "usd" } });
  });

  it("dryRun never hits the network and exposes inspect()", () => {
    const fi = new FinIntegrityClient({ dryRun: true });
    fi.ledger.record({ type: "payment", reference: "o1", external_id: "je_1", amount: { minor: 100, currency: "usd" } });
    expect(fi.inspect()).toHaveLength(1);
    expect(fi.inspect()[0]!.side).toBe("ledger");
  });
});
