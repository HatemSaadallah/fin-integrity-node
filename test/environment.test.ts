import { describe, it, expect } from "vitest";
import { FinIntegrityClient } from "../src/client.js";
import { cleanEnvironment } from "../src/environment.js";
import type { EventEnvelope, Transport } from "../src/types.js";

class Capture implements Transport {
  sent: EventEnvelope[] = [];
  async send(batch: EventEnvelope[]): Promise<void> {
    this.sent.push(...batch);
  }
}

const charge = {
  type: "payment" as const, source: "stripe", reference: "order_1",
  external_id: "ch_1", amount: { minor: 4999, currency: "usd" }, status: "succeeded",
};

describe("cleanEnvironment (Sentry rules)", () => {
  it("keeps a valid free-form tag verbatim (case-sensitive)", () => {
    expect(cleanEnvironment("Staging")).toBe("Staging");
    expect(cleanEnvironment("  production  ")).toBe("production");
  });
  it("rejects empty, over-long, whitespace/slash, and 'none'", () => {
    expect(cleanEnvironment("")).toBeUndefined();
    expect(cleanEnvironment("   ")).toBeUndefined();
    expect(cleanEnvironment("x".repeat(65))).toBeUndefined();
    expect(cleanEnvironment("has space")).toBeUndefined();
    expect(cleanEnvironment("a/b")).toBeUndefined();
    expect(cleanEnvironment("None")).toBeUndefined();
    expect(cleanEnvironment(undefined)).toBeUndefined();
  });
});

describe("environment on events", () => {
  it("stamps the config default on every event", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, environment: "staging", batch: { maxSize: 10 } });
    fi.processor.record(charge);
    await fi.flush();
    expect(t.sent[0]!.environment).toBe("staging");
  });

  it("lets a per-event override beat the config default", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, environment: "staging", batch: { maxSize: 10 } });
    fi.processor.record({ ...charge, environment: "production" });
    await fi.flush();
    expect(t.sent[0]!.environment).toBe("production");
  });

  it("drops an invalid override back to the default", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, environment: "staging", batch: { maxSize: 10 } });
    fi.processor.record({ ...charge, environment: "bad env" });
    await fi.flush();
    expect(t.sent[0]!.environment).toBe("staging");
  });

  it("omits environment entirely when none is set (server defaults to production)", async () => {
    const t = new Capture();
    // NODE_ENV is 'test' under vitest, so pass an explicit empty default to prove omission.
    const fi = new FinIntegrityClient({ transport: t, environment: "", batch: { maxSize: 10 } });
    fi.processor.record(charge);
    await fi.flush();
    expect(t.sent[0]!.environment).toBeUndefined();
  });

  it("puts environment in the idempotency key: same fact, two envs -> two rows", async () => {
    const t = new Capture();
    const fi = new FinIntegrityClient({ transport: t, batch: { maxSize: 10 } });
    fi.processor.record({ ...charge, environment: "staging" });
    fi.processor.record({ ...charge, environment: "production" });
    await fi.flush();
    expect(t.sent[0]!.idempotency_key).not.toBe(t.sent[1]!.idempotency_key);
  });
});
