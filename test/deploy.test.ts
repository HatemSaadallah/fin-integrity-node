import { describe, it, expect, vi, afterEach } from "vitest";
import { FinIntegrityClient } from "../src/client.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "dep_1" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("recordDeploy", () => {
  it("POSTs the release to /v1/deploys with auth and source=sdk", async () => {
    const calls = stubFetch();
    const fi = new FinIntegrityClient({ apiKey: "fi_sk_live_x", endpoint: "https://ingest.example.com" });
    await fi.recordDeploy("v2.3.0", { environment: "production" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ingest.example.com/v1/deploys");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer fi_sk_live_x");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ release: "v2.3.0", environment: "production", source: "sdk" });
  });

  it("never throws when the network fails (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const errors: unknown[] = [];
    const fi = new FinIntegrityClient({ apiKey: "fi_sk_live_x", onError: (e) => errors.push(e) });
    await expect(fi.recordDeploy("v2.3.0")).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("ignores an unusable release without calling the network", async () => {
    const calls = stubFetch();
    const fi = new FinIntegrityClient({ apiKey: "fi_sk_live_x" });
    await fi.recordDeploy("   ");
    expect(calls).toHaveLength(0);
  });
});
