/**
 * Minimal runnable example. Run against a local ingest endpoint:
 *   FIN_INTEGRITY_KEY=fi_sk_test_… FIN_INTEGRITY_ENDPOINT=http://localhost:3005 \
 *     npx tsx examples/quickstart.ts
 *
 * Or with no backend at all, in dry-run:
 *   npx tsx examples/quickstart.ts --dry
 */
import { init } from "../src/index.js";

const dry = process.argv.includes("--dry");
const fi = init({ apiKey: process.env.FIN_INTEGRITY_KEY, dryRun: dry, debug: true });

// A clean, reconciling pair
fi.processor.record({
  type: "payment",
  source: "stripe",
  reference: "order_1001",
  external_id: "ch_1001",
  amount: { minor: 4999, currency: "usd" },
  status: "succeeded",
});
fi.ledger.record({
  type: "payment",
  reference: "order_1001",
  external_id: "je_5001",
  amount: { minor: 4999, currency: "usd" },
});

// A mismatch fin-integrity will flag: ledger says 90.00, processor says 100.00
fi.processor.record({ type: "payment", source: "stripe", reference: "order_1002", external_id: "ch_1002", amount: { minor: 10000, currency: "usd" } });
fi.ledger.record({ type: "payment", reference: "order_1002", external_id: "je_5002", amount: { minor: 9000, currency: "usd" } });

await fi.flush();
if (dry) console.log("dry-run captured:", JSON.stringify(fi.inspect(), null, 2));
await fi.shutdown();
