// Offline tests: fake Keepa / Amazon / Discord responses, no keys needed. Run: npm test
import assert from "node:assert/strict";
import { settingsCommand, userSettings, analyseAsin, analyseEmbed, parseBulk, reqRoiFor, cfg, bulkRow, bulkFinish, bulkRun, rulesText, accessError } from "../src/worker.js";

const KM = (ms) => Math.round(ms / 60000) - 21564000;   // ms -> Keepa minutes
const now = Date.now(), day = 864e5;
const keepaProduct = {
  title: "Test Product Wireless Controller", monthlySold: 100, packageWeight: 300, packageLength: 200, packageWidth: 150, packageHeight: 60,
  referralFeePercentage: 15, fbaFees: { pickAndPackFee: 300 },
  stats: { avg90: Object.assign([], { 18: 2000 }), current: Object.assign([], { 0: 1999, 18: 1999 }), buyBoxPrice: 1999,
    buyBoxStats: { A3P5ROKL5A1OLE: { percentageWon: 60 }, SELLER2: { percentageWon: 40 } } },
  csv: Object.assign([], { 11: [KM(now - 60 * day), 4, KM(now - 2 * day), 5], 3: [], 1: [] }),
};
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  url = String(url); calls.push(url);
  const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://api.keepa.com/product")) return ok({ tokensLeft: 500, products: [keepaProduct] });
  if (url.startsWith("https://api.amazon.com/auth")) return ok({ access_token: "t" });
  if (url.includes("/offers?")) return ok({ payload: { Summary: { BuyBoxPrices: [{ condition: "New", LandedPrice: { Amount: 19.99 } }], NumberOfOffers: [{ condition: "new", fulfillmentChannel: "Amazon", OfferCount: 4 }] }, Offers: [{ SellerId: "A3P5ROKL5A1OLE" }] } });
  if (url.includes("/feesEstimate")) { const price = JSON.parse(opts.body).FeesEstimateRequest.PriceToEstimateFees.ListingPrice.Amount; return ok({ payload: { FeesEstimateResult: { Status: "Success", FeesEstimate: { TotalFeesEstimate: { Amount: price * 0.15 + 3 }, FeeDetailList: [{ FeeType: "ReferralFee", FinalFee: { Amount: price * 0.15 } }, { FeeType: "FBAFees", FinalFee: { Amount: 3 } }] } } } }); }
  if (url.includes("/restrictions")) return ok({ restrictions: [{ reasons: [{ message: "Approval required", links: [{ resource: "https://sellercentral.amazon.co.uk/hz/approvalrequest" }] }] }] });
  if (url.includes("/catalog/")) return ok({});
  if (url.startsWith("https://discord.com")) return new Response(JSON.stringify({ id: "1" }), { status: 200 });
  throw new Error("unexpected fetch " + url);
};
const store = {};
const kv = { get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = v; } };
const base = { KEEPA_API_KEY: "k", DISCORD_BOT_TOKEN: "d", SETUP_KEY: "s", BOT_KV: kv };
const amazon = { ...base, SPAPI_CLIENT_ID: "a", SPAPI_CLIENT_SECRET: "b", SPAPI_REFRESH_TOKEN: "c", SPAPI_SELLER_ID: "S1" };

// ladder
const c = cfg({});
assert.equal(reqRoiFor(5, c).roi, null);
assert.equal(reqRoiFor(12, c).roi, 0.8);
assert.equal(reqRoiFor(100, c).roi, 0.15);
assert.equal(reqRoiFor(null, c).roi, 0.2);
assert.equal(reqRoiFor(30, cfg({ ROI_LADDER: "5:0.5,25:0.25" })).roi, 0.25);

// bulk parsing
assert.deepEqual(parseBulk("B0AAAAAAA1 12.99, B0AAAAAAA2\nb0aaaaaaa1 3", 50), [{ asin: "B0AAAAAAA1", buy: 12.99 }, { asin: "B0AAAAAAA2", buy: null }]);

// access
assert.equal(accessError({ member: { user: { id: "u" }, roles: [] }, channel_id: "c1" }, cfg({ ALLOWED_ROLE_IDS: "r1" })), "You don't have the role needed to use this.");
assert.equal(accessError({ member: { user: { id: "u" }, roles: ["r1"] }, channel_id: "c1" }, cfg({ ALLOWED_ROLE_IDS: "r1" })), null);
assert.equal(accessError({ member: { user: { id: "boss" }, roles: [] }, channel_id: "x" }, cfg({ ALLOWED_CHANNEL_IDS: "c1", ADMIN_USER_IDS: "boss" })), null);

// Keepa-only mode
const k1 = await analyseAsin(base, "B0AAAAAAA1", 9.0);
assert.equal(k1.mode, "keepa");
assert.ok(k1.profit > 0 && k1.score >= 3, "keepa-only should score");
assert.ok(k1.warnings.some((w) => /Gating not checked/.test(w)));
console.log("Keepa-only:", { buyBox: k1.buyBox, fees: k1.fees.total.toFixed(2), profit: k1.profit.toFixed(2), roi: (k1.roi * 100).toFixed(1), score: k1.score, qty: k1.qty, minPrice: k1.minPrice });

// Amazon mode
const a1 = await analyseAsin(amazon, "B0AAAAAAA1", 9.0);
assert.equal(a1.mode, "amazon");
assert.equal(a1.fbaOffers, 4);
assert.ok(a1.gated);
assert.ok(!a1.warnings.some((w) => /Gating not checked/.test(w)));
console.log("Amazon:", { fees: a1.fees.total.toFixed(2), profit: a1.profit.toFixed(2), roi: (a1.roi * 100).toFixed(1), score: a1.score, qty: a1.qty, minPrice: a1.minPrice });

// not VAT-registered: no output VAT, but no VAT back on the buy price or Amazon's fees
const nv = await analyseAsin({ ...base, VAT_REGISTERED: "false" }, "B0AAAAAAA1", 9.0);
assert.equal(nv.vatOut, 0);
const expect = k1.profit + k1.vatOut - (9.0 - 9.0 / 1.2) - k1.fees.total * 0.2;
assert.ok(Math.abs(nv.profit - expect) < 0.01, `non-VAT profit ${nv.profit} vs ${expect}`);

// card renders
const e = analyseEmbed({ ...a1, graph: "https://x/graph.png" });
assert.ok(e.title.startsWith(["⛔", "🔴", "🟠", "🟡", "🟢", "💎"][a1.score]));
assert.ok(e.description.length < 4000 && e.image);
console.log("\n" + e.title + "\n" + e.description + "\n[" + e.footer.text + "]\n");
const unpriced = analyseEmbed(await analyseAsin(base, "B0AAAAAAA1", null));
assert.ok(unpriced.description.includes("Enter buy price"));

// bulk end to end through KV and the cron
store.bulk = JSON.stringify({ jobs: [{ id: "j", items: [{ asin: "B0AAAAAAA1", buy: 9 }, { asin: "B0AAAAAAA2", buy: 30 }, { asin: "B0AAAAAAA3", buy: null }], done: [], user: "u1", channel: "c1", origin: "https://bot.example.workers.dev" }] });
calls.length = 0;
console.log(await bulkRun({ ...base, BULK_PER_RUN: "10" }));
assert.equal(JSON.parse(store.bulk).jobs.length, 0, "job should finish");
assert.ok(calls.some((u) => u.includes("/channels/c1/messages")), "results posted to the channel");

// personal settings: a higher prep fee lowers profit for that person only
const msg = await settingsCommand(base, "u9", { prep_fee: 1.38, roi_ladder: "10:80, 20:25, 100:15", min_profit: 1.5 });
assert.ok(/Your rules/.test(msg), msg);
const mine = await userSettings(base, "u9");
assert.equal(mine.PREP_FEE, "1.38");
const p9 = await analyseAsin(base, "B0AAAAAAA1", 9.0, null, mine);
assert.ok(Math.abs((k1.profit - p9.profit) - 1.0) < 0.01, "prep +£1 should cut profit by £1");
assert.equal(cfg(base, mine).ladder[1][1], 0.25);
assert.ok(/Not saved: roi_ladder/.test(await settingsCommand(base, "u9", { roi_ladder: "rubbish" })));
assert.ok(/back to the server defaults/.test(await settingsCommand(base, "u9", { reset: true })));
assert.deepEqual(await userSettings(base, "u9"), {});
console.log(msg + "\n");
console.log(rulesText({}));
console.log("\nAll tests passed.");
