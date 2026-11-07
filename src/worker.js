// A2A Analyse Bot: a Discord bot that scores Amazon UK products for Amazon-to-Amazon (A2A) / online arbitrage buys.
// Runs on Cloudflare Workers. Every user deploys their own copy with their own Keepa, Amazon and Discord keys.
// Settings live in wrangler.toml [vars]; keys are Cloudflare secrets (see README.md).
//
// Commands:  /analyse ASIN [buy]   /analyse_bulk [list] [file]   /analyse_rules
// Routes:    POST /interactions  (Discord)   GET /register?key=SETUP_KEY  (registers the commands)
//            GET /graph/<ASIN>.png?s=<sig>  (Keepa price graph, fetched server-side so the Keepa key never reaches Discord)

const MP = "A1F83G8C2ARO7P";                                  // Amazon UK marketplace
const SP = "https://sellingpartnerapi-eu.amazon.com";
const AMAZON_UK_SELLER = "A3P5ROKL5A1OLE";                    // Amazon's own seller ID on amazon.co.uk (public)
const KEEPA_DOMAIN = 2;                                       // Keepa: 2 = amazon.co.uk
const ASIN_RE = /\b(B0[0-9A-Z]{8}|\d{9}[\dX])\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const gbp2 = (n) => (n < 0 ? "-£" : "£") + Math.abs(Number(n || 0)).toFixed(2);
const pc1 = (x) => (x * 100).toFixed(1) + "%";
const today = () => new Date().toISOString().slice(0, 10);
const dmon = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const short60 = (s) => { s = String(s || "").split("\n")[0].trim(); if (s.length < 60) return s; const c = s.slice(0, 59), i = c.lastIndexOf(" "); return (i > 0 ? c.slice(0, i) : c) + "…"; };
const clean = (s) => String(s || "").replace(/["'\\{}<>@]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
const list = (s) => String(s || "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------- settings (wrangler.toml [vars])
// `over` = one person's own settings from /analyse_settings (same names as the [vars]); they win over the server defaults
const PERSONAL = ["VAT_REGISTERED", "PREP_FEE", "INBOUND_PER_KG", "STORAGE_PER_CUFT", "ROI_LADDER", "UNKNOWN_SALES_ROI", "MIN_PROFIT", "TARGET_PROFIT", "MIN_PRICE_ROI"];
const ROI_KEYS = ["UNKNOWN_SALES_ROI", "STRONG_ROI_MARGIN", "MIN_PRICE_ROI"];
const asRoi = (x) => (x > 1 ? x / 100 : x);   // accepts 0.20 or 20 for 20%
function parseLadder(str) {
  return String(str || "").split(",").map((p) => p.split(":").map((x) => Number(String(x).replace("%", "").trim())))
    .filter((p) => p.length === 2 && p.every((x) => !isNaN(x) && x >= 0)).map(([m, r]) => [m, asRoi(r)]).sort((a, b) => a[0] - b[0]);
}
function cfg(env, over = {}) {
  const v = (k) => (over[k] !== undefined && over[k] !== "" ? over[k] : env[k]);
  const num = (k, d) => { const x = v(k); if (x === undefined || x === "") return d; const n = Number(x); return isNaN(n) ? d : ROI_KEYS.includes(k) ? asRoi(n) : n; };
  const yes = (k, d) => { const x = v(k); return x === undefined || x === "" ? d : /^(1|true|yes|on)$/i.test(String(x)); };
  const ladder = parseLadder(v("ROI_LADDER") || "10:0.80,15:0.30,20:0.20,50:0.17,100:0.15");
  return {
    vat: yes("VAT_REGISTERED", true),
    prep: num("PREP_FEE", 0.38), inboundKg: num("INBOUND_PER_KG", 0.30), storageCuft: num("STORAGE_PER_CUFT", 1.10),
    ladder, unknownRoi: num("UNKNOWN_SALES_ROI", 0.20),
    minProfit: num("MIN_PROFIT", 1), targetProfit: num("TARGET_PROFIT", 2),
    strongRoiMargin: num("STRONG_ROI_MARGIN", 0.10), strongProfit: num("STRONG_PROFIT", 3), strongSales: num("STRONG_SALES", 30),
    minPriceRoi: num("MIN_PRICE_ROI", 0.15), q4LastYear: yes("Q4_USE_LAST_YEAR", true), fallbackFba: num("FALLBACK_FBA_FEE", 3.0),
    roles: list(env.ALLOWED_ROLE_IDS), channels: list(env.ALLOWED_CHANNEL_IDS), admins: list(env.ADMIN_USER_IDS),
    dailyLimit: num("DAILY_LIMIT", 0), bulkMax: num("BULK_MAX", 50), bulkPerRun: num("BULK_PER_RUN", 4),
  };
}
const hasSpapi = (env) => !!(env.SPAPI_CLIENT_ID && env.SPAPI_CLIENT_SECRET && env.SPAPI_REFRESH_TOKEN);

// ---------------------------------------------------------------- Amazon SP-API (optional)
async function spToken(env) {
  const r = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: env.SPAPI_REFRESH_TOKEN, client_id: env.SPAPI_CLIENT_ID, client_secret: env.SPAPI_CLIENT_SECRET }) });
  if (!r.ok) throw new Error("Amazon sign-in failed (HTTP " + r.status + "): check your SP-API keys");
  return (await r.json()).access_token;
}
async function sp(tok, path, opts = {}) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(SP + path, { ...opts, headers: { "x-amz-access-token": tok, "content-type": "application/json", ...(opts.headers || {}) } });
    if (r.status === 429) { await sleep(3000); continue; }
    if (!r.ok) throw new Error(`Amazon ${path.split("?")[0]} HTTP ${r.status}`);
    return r.json();
  }
  throw new Error("Amazon rate limit");
}
async function spFees(tok, asin, price) {
  const j = await sp(tok, `/products/fees/v0/items/${asin}/feesEstimate`, { method: "POST", body: JSON.stringify({ FeesEstimateRequest: {
    MarketplaceId: MP, IsAmazonFulfilled: true, Identifier: asin + "-" + Date.now(), PriceToEstimateFees: { ListingPrice: { CurrencyCode: "GBP", Amount: Math.max(Number(price.toFixed(2)), 0.5) } } } }) });
  const est = j.payload && j.payload.FeesEstimateResult;
  if (!est || est.Status !== "Success") throw new Error("Amazon fee estimate failed" + (est && est.Error ? ": " + (est.Error.Message || est.Error.Code) : ""));
  const items = est.FeesEstimate.FeeDetailList || [];
  const part = (re) => items.filter((f) => re.test(f.FeeType)).reduce((s, f) => s + Number((f.FinalFee || f.FeeAmount || {}).Amount || 0), 0);
  let total = Number(est.FeesEstimate.TotalFeesEstimate.Amount);
  const hasDst = items.some((f) => /digital/i.test(f.FeeType));
  if (!hasDst) total *= 1.02;   // add the 2% digital services fee when Amazon's estimate leaves it out
  return { total, referral: part(/Referral/i), fba: part(/FBA|Fulfil/i), closing: part(/Closing/i), source: "Amazon" };
}
// Keepa-only fee estimate: referral % and FBA pick & pack fee from Keepa, plus the 2% digital services fee.
function keepaFees(kp, price, c, warn) {
  const pct = Number(kp && (kp.referralFeePercentage ?? kp.referralFeePercent));
  const referral = price * ((pct > 0 ? pct : 15) / 100);
  const pp = kp && kp.fbaFees && kp.fbaFees.pickAndPackFee > 0 ? kp.fbaFees.pickAndPackFee / 100 : null;
  if (warn && !(pct > 0)) warn("Referral fee % unknown: assumed 15%");
  if (warn && pp == null) warn(`FBA fee unknown: assumed ${gbp2(c.fallbackFba)}`);
  const fba = pp == null ? c.fallbackFba : pp;
  return { total: (referral + fba) * 1.02, referral, fba, closing: 0, source: "Keepa estimate" };
}

// ---------------------------------------------------------------- rules
function reqRoiFor(monthly, c) {
  if (monthly == null) return { roi: c.unknownRoi, note: `sales unknown, using ${Math.round(c.unknownRoi * 100)}%` };
  if (!c.ladder.length) return { roi: c.unknownRoi, note: `needs ${Math.round(c.unknownRoi * 100)}%` };
  if (monthly < c.ladder[0][0]) return { roi: null, note: `~${monthly}/mo, under the ${c.ladder[0][0]}/mo minimum` };
  let roi = c.ladder[0][1];
  for (const [min, r] of c.ladder) if (monthly >= min) roi = r;
  return { roi, note: `~${monthly}/mo needs ${Math.round(roi * 1000) / 10}%` };
}
const kTime = (km) => (km + 21564000) * 60000;   // Keepa minutes -> ms
// Same season last year: in Q4 (Oct-Dec) look at last year's Q4; otherwise from 2 weeks before to 6 weeks after today's date last year.
function lastSeason(kp, day = today()) {
  if (!kp || !kp.csv) return null;
  const y = +day.slice(0, 4), mth = +day.slice(5, 7), q4 = mth >= 10;
  const from = q4 ? Date.parse(`${y - 1}-10-01T00:00:00Z`) : Date.parse(day + "T00:00:00Z") - 379 * 864e5;
  const to = q4 ? Date.parse(`${y - 1}-12-31T23:59:59Z`) : Date.parse(day + "T00:00:00Z") - 323 * 864e5;
  const days = (to - from) / 864e5, label = q4 ? `Q4 ${y - 1}` : `${dmon(new Date(from).toISOString().slice(0, 10))}–${dmon(new Date(to).toISOString().slice(0, 10))} ${y - 1}`;
  const series = (arr, step) => { const pts = []; if (!arr) return pts; for (let i = 0; i + step - 1 < arr.length; i += step) pts.push([kTime(arr[i]), step === 3 ? (arr[i + 1] >= 0 ? arr[i + 1] + Math.max(arr[i + 2], 0) : -1) : arr[i + 1]]); return pts; };
  const inWin = (pts) => { const out = [], before = pts.filter((p) => p[0] < from).pop(); if (before) out.push([from, before[1]]); return out.concat(pts.filter((p) => p[0] >= from && p[0] <= to)); };
  const bb = inWin(series(kp.csv[18], 3)).filter((p) => p[1] > 0).map((p) => p[1] / 100);
  const nw = inWin(series(kp.csv[1], 2)).filter((p) => p[1] > 0).map((p) => p[1] / 100);
  const prices = bb.length ? bb : nw;
  const rank = series(kp.csv[3], 2).filter((p) => p[0] >= from && p[0] <= to && p[1] > 0);
  let drops = 0; for (let i = 1; i < rank.length; i++) if (rank[i][1] < rank[i - 1][1]) drops++;
  const msh = kp.monthlySoldHistory ? series(kp.monthlySoldHistory, 2).filter((p) => p[0] >= from && p[0] <= to && p[1] > 0).map((p) => p[1]) : [];
  const monthly = msh.length ? Math.round(msh.reduce((a, b) => a + b, 0) / msh.length) : (rank.length > 5 ? Math.round(drops * 30 / days) : null);
  if (!prices.length && monthly == null) return { label, none: true };
  return { label, q4, monthly, avg: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null };
}

// ---------------------------------------------------------------- the analysis
async function analyseAsin(env, asin, buy, spTok, over = {}) {
  const c = cfg(env, over), useSp = hasSpapi(env);
  const tok = useSp ? spTok || await spToken(env) : null;
  const out = { asin, buy: buy > 0 ? buy : null, warnings: [], mode: useSp ? "amazon" : "keepa" };
  const warn = (w) => out.warnings.push(w);
  if (!env.KEEPA_API_KEY) throw new Error("KEEPA_API_KEY isn't set (see README)");
  const r = await fetch(`https://api.keepa.com/product?key=${env.KEEPA_API_KEY}&domain=${KEEPA_DOMAIN}&asin=${asin}&stats=90&buybox=1&days=500`).catch(() => null);
  const j = r && r.ok ? await r.json() : null;
  const kp = j && j.products && j.products[0];
  out.tokensLeft = j ? j.tokensLeft : null;
  if (!kp) throw new Error(r && r.status === 429 ? "Keepa is out of tokens, try again in a few minutes" : `Keepa lookup failed${r ? ` (HTTP ${r.status})` : ""}`);
  const st = kp.stats || {};
  const pence = (v) => (v != null && v > 0 ? v / 100 : null);
  out.title = kp.title || "";
  out.monthly = kp.monthlySold > 0 ? kp.monthlySold : (st.salesRankDrops30 > 0 ? st.salesRankDrops30 : null);
  out.season = lastSeason(kp);
  out.avg90 = pence(st.avg90 && st.avg90[18]) || pence(st.avg90 && st.avg90[1]);
  out.hazmat = !!(kp.hazardousMaterials && kp.hazardousMaterials.length);
  out.variation = !!((kp.variations && kp.variations.length > 1) || (kp.parentAsin && kp.parentAsin !== asin));
  const bbs = st.buyBoxStats || null;
  if (bbs) {
    out.amazonShare = bbs[AMAZON_UK_SELLER] ? Number(bbs[AMAZON_UK_SELLER].percentageWon) / 100 : 0;
    const top = Object.entries(bbs).filter(([id]) => id !== AMAZON_UK_SELLER).sort((a, b) => b[1].percentageWon - a[1].percentageWon)[0];
    if (top && top[1].percentageWon >= 80) out.oneSeller = Math.round(top[1].percentageWon);
  }
  if (kp.csv && kp.csv[11]) {   // new-offer count now vs 30 days ago
    const h = kp.csv[11], cut = Date.now() - 30 * 864e5; let now = null, then = null;
    for (let i = 0; i + 1 < h.length; i += 2) { const v = h[i + 1]; if (v < 0) continue; now = v; if (kTime(h[i]) <= cut) then = v; }
    out.offersNow = now; out.offers30 = then;
    out.pilingIn = then != null && now != null && now - then >= 2 && now >= then * 1.5;
  }
  let grams = kp.packageWeight > 0 ? kp.packageWeight : kp.itemWeight > 0 ? kp.itemWeight : 0;
  let dims = kp.packageLength > 0 ? [kp.packageLength, kp.packageWidth, kp.packageHeight] : null;   // mm
  out.amazonOn = !!(st.current && st.current[0] > 0);
  out.buyBox = pence(st.buyBoxPrice) || pence(st.current && st.current[18]) || pence(st.current && st.current[1]);
  if (useSp) {   // live offers, Buy Box and FBA seller count straight from Amazon
    const off = await sp(tok, `/products/pricing/v0/items/${asin}/offers?MarketplaceId=${MP}&ItemCondition=New`).catch(() => null);
    const pl = off && off.payload;
    const bbp = pl && pl.Summary && (pl.Summary.BuyBoxPrices || []).find((b) => /new/i.test(b.condition || "New"));
    if (bbp) out.buyBox = Number(bbp.LandedPrice.Amount);
    if (pl && (pl.Offers || []).some((o) => o.SellerId === AMAZON_UK_SELLER)) out.amazonOn = true;
    out.fbaOffers = pl && pl.Summary ? (pl.Summary.NumberOfOffers || []).filter((n) => /new/i.test(n.condition) && /amazon/i.test(n.fulfillmentChannel)).reduce((s, n) => s + n.OfferCount, 0) : null;
    if (!out.title || !grams || !dims) {
      const cat = await sp(tok, `/catalog/2022-04-01/items/${asin}?marketplaceIds=${MP}&includedData=summaries,dimensions`).catch(() => null);
      if (cat) {
        out.title = out.title || ((cat.summaries || [])[0] || {}).itemName || "";
        const pk = ((cat.dimensions || [])[0] || {}).package || {};
        const toMm = (d) => d && (d.unit === "inches" ? d.value * 25.4 : d.unit === "centimeters" ? d.value * 10 : d.value);
        if (!grams && pk.weight) grams = pk.weight.unit === "pounds" ? pk.weight.value * 453.6 : pk.weight.unit === "kilograms" ? pk.weight.value * 1000 : pk.weight.value;
        if (!dims && pk.length) dims = [toMm(pk.length), toMm(pk.width), toMm(pk.height)];
      }
    }
    if (env.SPAPI_SELLER_ID) {
      const g = await sp(tok, `/listings/2021-08-01/restrictions?asin=${asin}&sellerId=${env.SPAPI_SELLER_ID}&marketplaceIds=${MP}&conditionType=new_new`).catch(() => null);
      const rs = (g && g.restrictions) || [];
      if (rs.length) { const reason = (rs[0].reasons || [])[0] || {}; out.gated = { link: ((reason.links || [])[0] || {}).resource || "" }; }
    }
  }
  if (!out.buyBox) throw new Error("no Buy Box or new offer price found for " + asin);
  out.inbound = c.inboundKg * ((grams || 0) / 1000);
  out.storage = dims ? c.storageCuft * (dims[0] * dims[1] * dims[2]) / 28316846.6 : 0;
  if (!grams) warn("Weight unknown: inbound shipping left out");
  if (!dims) warn("Size unknown: storage left out");
  // money at the Buy Box
  const fees = async (price, w) => (useSp ? spFees(tok, asin, price) : keepaFees(kp, price, c, w));
  const f = await fees(out.buyBox, warn);
  out.fees = f;
  const feeMult = c.vat ? 1 : 1.2;            // not VAT-registered: Amazon's fees carry VAT you can't reclaim
  const k = c.vat ? 1 / 1.2 : 1;              // share of the buy price that is a cost (VAT reclaimed if registered)
  const outVat = c.vat ? out.buyBox / 6 : 0;
  const left = out.buyBox - outVat - f.total * feeMult - c.prep - out.inbound - out.storage;   // left before stock cost
  out.vatOut = outVat;
  const maxFor = (roi, minP) => Math.max(0, Math.min(left / (k + roi), (left - minP) / k));
  out.maxFloor = maxFor(c.minPriceRoi, c.minProfit);
  let req = reqRoiFor(out.monthly, c);
  const ss = out.season && !out.season.none ? out.season : null;
  const q4Faster = c.q4LastYear && ss && ss.q4 && ss.monthly != null && ss.monthly > (out.monthly || 0);
  if (q4Faster) {
    const r2 = reqRoiFor(ss.monthly, c);
    if (r2.roi != null && (req.roi == null || r2.roi < req.roi)) req = { roi: r2.roi, note: `${r2.note} (${ss.label} sales)` };
  }
  out.req = req;
  const velocity = Math.max(out.monthly || 0, q4Faster ? ss.monthly : 0) || null;
  if (velocity) {   // a month's sales split evenly between you, the other sellers and Amazon
    const sellers = out.fbaOffers != null ? out.fbaOffers : (out.offersNow || 0);
    const others = Math.max(0, sellers - (out.amazonOn ? 1 : 0));
    out.qty = Math.max(0, Math.floor(velocity / (others + 1 + (out.amazonOn ? 1 : 0))));
  }
  if (ss && ss.avg) {
    const ch = ss.avg / out.buyBox - 1;
    out.seasonDrop = ch <= -0.10;
    if (out.seasonDrop) warn(`In ${ss.label} the Buy Box averaged ${gbp2(ss.avg)}, ${Math.round(-ch * 100)}% under today: price may drop`);
  }
  if (req.roi) out.maxReq = maxFor(req.roi, c.minProfit);
  const spike = out.avg90 && out.buyBox > out.avg90 * 1.15;
  if (spike) warn(`Buy Box is ${Math.round((out.buyBox / out.avg90 - 1) * 100)}% above its 90-day average`);
  if (out.pilingIn) warn(`Sellers piling in: ${out.offers30} → ${out.offersNow} offers in 30 days`);
  if (out.oneSeller && !out.amazonOn) warn(`One seller has held the Buy Box ${out.oneSeller}% of the time: likely the brand or private label (IP risk)`);
  if (out.variation) warn("Variation listing: check you're buying the exact child ASIN");
  if (out.hazmat) warn("Dangerous goods (hazmat) listing");
  if (!useSp) warn("Gating not checked (no Amazon login)");
  if (out.buy) {
    out.profit = left - out.buy * k;
    out.roi = out.profit / out.buy;
    let score;
    if (out.profit <= 0) score = 0;
    else if (!req.roi || out.profit < c.minProfit || out.roi < req.roi) score = 1;
    else if (out.profit < c.targetProfit) score = 3;
    else score = 4;
    const penalty = spike || out.seasonDrop || out.pilingIn;
    if (score === 4 && out.roi >= req.roi + c.strongRoiMargin && out.profit >= c.strongProfit && (velocity || 0) >= c.strongSales && !penalty) score = 5;
    if (score === 4 && penalty) score = 3;           // one point at most, never below Maybe
    if (!velocity && score > 3) score = 3;          // sales unknown: capped at Maybe
    out.score = score;
    // lowest sale price that still clears MIN_PRICE_ROI and MIN_PROFIT at this buy price (for your repricer)
    const need = Math.max(c.minProfit, c.minPriceRoi * out.buy) + out.buy * k + c.prep + out.inbound + out.storage;
    const vatShare = c.vat ? 5 / 6 : 1;
    let p = (need + f.total * feeMult) / vatShare;
    for (let n = 0; n < 2; n++) { const fp = await fees(p).catch(() => f); p = (need + fp.total * feeMult) / vatShare; }
    out.minPrice = Math.ceil(p * 100) / 100;
  }
  return out;
}

// ---------------------------------------------------------------- Discord card
const SCORE_ICON = ["⛔", "🔴", "🟠", "🟡", "🟢", "💎"];
const SCORE_COLOUR = [0x7f8c8d, 0xe74c3c, 0xe67e22, 0xf1c40f, 0x2ecc71, 0x9b59b6];
const SCORE_WORD = ["Loss", "Skip", "Weak", "Maybe", "Buy", "Strong buy"];
function analyseEmbed(a) {
  const g = (x) => (x == null ? "?" : gbp2(x)), pct = (x) => (x == null ? "?" : Math.round(x * 1000) / 10 + "%");
  const scored = a.buy && a.score != null;
  const L = [];
  if (!scored) L.push("Tap **Enter buy price** to score it.", "");
  if (scored) L.push(`💷  **${g(a.buy)}** → **${g(a.profit)}** profit · **${pct(a.roi)}** ROI`);
  L.push(`📈  Buy Box **${g(a.buyBox)}**${a.avg90 ? ` (90d avg ${g(a.avg90)})` : ""} · **${a.monthly ? "~" + a.monthly : "?"}/mo**`);
  const sellers = a.fbaOffers != null ? `**${a.fbaOffers}** FBA · ${a.offersNow ?? "?"} offers` : `**${a.offersNow ?? "?"}** offers`;
  L.push(`👥  ${sellers}${a.offers30 != null ? ` (${a.offers30} last month)` : ""}${a.amazonOn ? ` · Amazon on${a.amazonShare != null ? ` (${Math.round(a.amazonShare * 100)}% BB)` : ""}` : ""}`);
  L.push(`🎯  Max buy **${g(a.maxReq != null ? a.maxReq : a.maxFloor)}** · Qty **${a.qty ?? "?"}**${scored ? ` · Min price ${g(a.minPrice)}` : ""}`);
  const warn = [];
  if (a.gated) warn.push(`🔒  **Gated**${a.gated.link ? ` · [request approval](${a.gated.link})` : ""}`);
  for (const w of a.warnings) warn.push("⚠️  " + w);
  if (warn.length) L.push("", ...warn);
  const s = a.season;
  if (s && !s.none) L.push("", `-# Last ${s.label}: ${g(s.avg)} avg · ${s.monthly != null ? "~" + s.monthly + "/mo" : "sales ?"}`);
  L.push("", `[Keepa](https://keepa.com/#!product/${KEEPA_DOMAIN}-${a.asin}) · [SAS](https://sas.selleramp.com/sas/lookup?search_term=${a.asin}&asin=${a.asin}) · [Amazon](https://www.amazon.co.uk/dp/${a.asin})`);
  const e = {
    title: ((scored ? `${SCORE_ICON[a.score]} ${a.score}/5 ${SCORE_WORD[a.score]}` : "🔍 Check") + " · " + short60(a.title || a.asin)).slice(0, 256),
    url: `https://www.amazon.co.uk/dp/${a.asin}`, color: scored ? SCORE_COLOUR[a.score] : 0x5865f2,
    description: L.join("\n").slice(0, 4000),
    footer: { text: `${a.asin} · ${a.req ? a.req.note : ""} · fees ${g(a.fees && a.fees.total)} (${a.fees ? a.fees.source : "?"})${a.vatOut ? ` · VAT ${g(a.vatOut)}` : ""} · estimates only, check before buying` },
  };
  if (a.graph) e.image = { url: a.graph };
  return e;
}
const btn = (label, id, style = 2) => ({ type: 2, style, label: String(label).slice(0, 80), custom_id: String(id).slice(0, 100) });
const row = (...b) => ({ type: 1, components: b.slice(0, 5) });
const analyseButtons = (asin, priced) => [row(btn(priced ? "💷 Try another price" : "💷 Enter buy price", `an|buy|${asin}`, priced ? 2 : 1))];
const buyModal = (asin) => ({ type: 9, data: { custom_id: `anm|${asin}`, title: `Buy price for ${asin}`, components: [row({ type: 4, custom_id: "buy", label: "Buy price per unit (£, inc VAT)", style: 1, min_length: 1, max_length: 10, required: true, placeholder: "12.99" })] } });

// Keepa graph, signed per ASIN so nobody can use your worker to spend your Keepa tokens
async function graphSig(env, asin) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((env.SETUP_KEY || "") + "|graph|" + asin));
  return [...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const graphUrl = async (env, origin, asin) => `${origin}/graph/${asin}.png?s=${await graphSig(env, asin)}&d=${today()}`;
async function keepaGraph(req, env, ctx, asin) {
  if (new URL(req.url).searchParams.get("s") !== await graphSig(env, asin)) return new Response("Not found", { status: 404 });
  const cache = caches.default, hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(`https://api.keepa.com/graphimage?key=${env.KEEPA_API_KEY}&domain=${KEEPA_DOMAIN}&asin=${asin}&bb=1&amazon=1&new=1&salesrank=1&range=90&width=700&height=300`);
  if (!r.ok) return new Response("graph unavailable", { status: 502 });
  const res = new Response(await r.arrayBuffer(), { headers: { "content-type": "image/png", "cache-control": "public, max-age=21600" } });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

async function analyseReply(env, origin, asinRaw, buyRaw, over = {}) {
  const asin = (String(asinRaw || "").toUpperCase().match(ASIN_RE) || [])[1];
  if (!asin) return { content: `"${clean(asinRaw)}" isn't an ASIN (it should look like B0AAAAAAA1).` };
  const buy = buyRaw == null || buyRaw === "" ? null : Number(String(buyRaw).replace(/[£,\s]/g, ""));
  if (buy != null && !(buy > 0)) return { content: `"${clean(buyRaw)}" isn't a price.` };
  const a = await analyseAsin(env, asin, buy, null, over);
  a.graph = await graphUrl(env, origin, asin);
  return { content: "", embeds: [analyseEmbed(a)], components: analyseButtons(asin, buy != null) };
}

// ---------------------------------------------------------------- Discord helpers
async function dc(env, method, path, body) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://discord.com/api/v10" + path, { method, headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep(Math.ceil((j.retry_after || 1) * 1000) + 250); continue; }
    if (!r.ok) throw new Error(`Discord ${method} ${path.split("?")[0]} HTTP ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error("Discord rate limit");
}
async function dcFile(env, channel, content, filename, text) {
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify({ content, allowed_mentions: { parse: [] } }));
  fd.append("files[0]", new Blob([text], { type: "text/csv" }), filename);
  const r = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, { method: "POST", headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN }, body: fd });
  if (!r.ok) throw new Error("Discord file upload HTTP " + r.status);
}
const hex = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
async function verifyDiscord(req, body, pub) {
  const sig = req.headers.get("x-signature-ed25519"), ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts || !pub) return false;
  const key = await crypto.subtle.importKey("raw", hex(pub), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, hex(sig), new TextEncoder().encode(ts + body));
}

// ---------------------------------------------------------------- access and daily limits
function accessError(i, c) {
  if (!i.member) return "This bot only works in a server channel.";
  if (c.admins.includes(i.member.user.id)) return null;
  if (c.channels.length && !c.channels.includes(i.channel_id)) return `Use this in ${c.channels.map((x) => `<#${x}>`).join(" or ")}.`;
  if (c.roles.length && !(i.member.roles || []).some((r) => c.roles.includes(r))) return "You don't have the role needed to use this.";
  return null;
}
// counts lookups per person per day in KV; returns how many are left, or -1 when over the limit
async function useQuota(env, c, userId, n) {
  if (!c.dailyLimit || c.admins.includes(userId) || !env.BOT_KV) return Infinity;
  const key = `use:${today()}:${userId}`, used = Number(await env.BOT_KV.get(key)) || 0;
  if (used + n > c.dailyLimit) return -1;
  await env.BOT_KV.put(key, String(used + n), { expirationTtl: 172800 });
  return c.dailyLimit - used - n;
}

// ---------------------------------------------------------------- personal settings (/analyse_settings), kept in KV per person
async function userSettings(env, userId) {
  if (!env.BOT_KV) return {};
  try { return JSON.parse((await env.BOT_KV.get("set:" + userId)) || "{}"); } catch (_) { return {}; }
}
const SETTING_OPTS = { prep_fee: "PREP_FEE", inbound_per_kg: "INBOUND_PER_KG", storage_per_cuft: "STORAGE_PER_CUFT", vat_registered: "VAT_REGISTERED",
  min_profit: "MIN_PROFIT", target_profit: "TARGET_PROFIT", roi_ladder: "ROI_LADDER", unknown_sales_roi: "UNKNOWN_SALES_ROI", min_price_roi: "MIN_PRICE_ROI" };
async function settingsCommand(env, userId, opt) {
  if (!env.BOT_KV) return "Personal settings need the BOT_KV storage set up (see README).";
  let s = await userSettings(env, userId);
  if (opt.reset) s = {};
  const bad = [];
  for (const [o, k] of Object.entries(SETTING_OPTS)) {
    if (opt[o] === undefined) continue;
    if (o === "roi_ladder") { if (!parseLadder(opt[o]).length) { bad.push("roi_ladder (use e.g. 10:80, 20:20, 100:15)"); continue; } s[k] = String(opt[o]); }
    else if (o === "vat_registered") s[k] = opt[o] ? "true" : "false";
    else if (!(Number(opt[o]) >= 0)) bad.push(o);
    else s[k] = String(opt[o]);
  }
  await env.BOT_KV.put("set:" + userId, JSON.stringify(s));
  return (bad.length ? `⚠️ Not saved: ${bad.join(", ")}\n\n` : "") + (opt.reset ? "Your settings are back to the server defaults.\n\n" : "") + rulesText(env, s);
}

// ---------------------------------------------------------------- /analyse_bulk (queued in KV, worked by the cron)
function parseBulk(text, max) {
  const out = [], seen = new Set();
  for (const line of String(text || "").split(/\r?\n|;/)) {
    for (const m of line.matchAll(/\b(B0[0-9A-Z]{8}|\d{9}[\dX])\b/gi)) {
      const asin = m[1].toUpperCase(); if (seen.has(asin)) continue;
      const pm = line.slice(m.index + m[0].length).match(/^[\s,:\t|"]*£?\s*(\d{1,5}(?:\.\d{1,2})?)(?![\d-])/);
      seen.add(asin); out.push({ asin, buy: pm ? Number(pm[1]) : null });
    }
  }
  return out.slice(0, max);
}
async function bulkState(env) { let st = {}; try { st = JSON.parse((await env.BOT_KV.get("bulk")) || "{}"); } catch (_) {} st.jobs = st.jobs || []; return st; }
const bulkSave = (env, st) => env.BOT_KV.put("bulk", JSON.stringify(st));
function bulkRow(a, it) {
  return { asin: a.asin, t: short60(a.title || "").slice(0, 70), buy: it.buy, bb: a.buyBox, p: a.profit, r: a.roi, sc: a.score, req: a.req && a.req.roi, mr: a.maxReq, mf: a.maxFloor,
    q: a.qty, mo: a.monthly, fba: a.fbaOffers ?? a.offersNow, az: a.amazonShare, g: a.gated ? 1 : 0, mp: a.minPrice, w: a.warnings.filter((w) => !/^Gating not checked/.test(w)).join(" | ").slice(0, 200),
    e: a.buy && a.score >= 4 ? { asin: a.asin, title: (a.title || "").slice(0, 80), buy: a.buy, score: a.score, profit: a.profit, roi: a.roi, buyBox: a.buyBox, avg90: a.avg90, monthly: a.monthly,
      fbaOffers: a.fbaOffers, offersNow: a.offersNow, offers30: a.offers30, amazonOn: a.amazonOn, amazonShare: a.amazonShare, maxReq: a.maxReq, maxFloor: a.maxFloor, qty: a.qty, minPrice: a.minPrice,
      warnings: a.warnings, gated: a.gated || null, season: a.season && !a.season.none ? { label: a.season.label, avg: a.season.avg, monthly: a.season.monthly } : null,
      req: { note: a.req && a.req.note }, fees: { total: a.fees && a.fees.total, source: a.fees && a.fees.source }, vatOut: a.vatOut } : undefined };
}
const csvCell = (v) => { const s = v == null ? "" : typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
async function bulkFinish(env, job) {
  const rows = job.done.slice().sort((a, b) => (b.sc ?? -1) - (a.sc ?? -1) || (b.r ?? -9) - (a.r ?? -9) || (b.mr ?? 0) - (a.mr ?? 0));
  const url = (x) => `https://www.amazon.co.uk/dp/${x.asin}`;
  const ttl = (x, n) => (x.t || x.asin).replace(/[\[\]]/g, "").slice(0, n);
  const gp = (x) => (x == null ? "?" : gbp2(x));
  const mid = (x) => `**[${ttl(x, 55)}](${url(x)})**\n💷  **${gp(x.buy)}** → **${gp(x.p)}** profit · **${pc1(x.r)}** ROI\n📈  Buy Box ${gp(x.bb)} · **${x.mo ? "~" + x.mo : "?"}/mo** · ${x.fba ?? "?"} sellers\n🎯  Max buy **${gp(x.mr != null ? x.mr : x.mf)}** · Qty **${x.q ?? "?"}**${x.g ? "\n🔒  **Gated**" : ""}${x.w ? `\n⚠️  ${x.w.split(" | ")[0].slice(0, 90)}` : ""}`;
  const skip = (x) => `\`${x.asin}\` [${ttl(x, 34)}](${url(x)}) · ${gp(x.buy)} → ${gp(x.p)} · ${x.r != null ? pc1(x.r) : "?"}${x.g ? " 🔒" : ""}`;
  const noPrice = (x) => `\`${x.asin}\` [${ttl(x, 34)}](${url(x)}) · 🎯 max buy **${gp(x.mr != null ? x.mr : x.mf)}** · ${x.mo ? "~" + x.mo : "?"}/mo · qty ${x.q ?? "?"}${x.g ? " 🔒" : ""}`;
  const failed = (x) => `\`${x.asin}\` ${x.err}`;
  const buys = rows.filter((x) => !x.err && x.buy && x.sc >= 4);
  const groups = [
    ["🟡 Maybe", 0xf1c40f, rows.filter((x) => !x.err && x.buy && x.sc === 3), mid, "\n\n"],
    ["🔴 Skip", 0xe74c3c, rows.filter((x) => !x.err && x.buy && x.sc <= 2), skip, "\n"],
    ["➖ No buy price", 0x95a5a6, rows.filter((x) => !x.err && !x.buy), noPrice, "\n"],
    ["⚠️ Couldn't analyse", 0x7f8c8d, rows.filter((x) => x.err), failed, "\n"],
  ];
  const count = (sc) => buys.filter((x) => x.sc === sc).length;
  const tally = [["💎 Strong buy", count(5)], ["🟢 Buy", count(4)], ...groups.map((g) => [g[0], g[2].length])].filter((t) => t[1]);
  const embeds = [{ title: `📊 Bulk analysis · ${rows.length} ASINs`, color: buys.length ? (count(5) ? 0x9b59b6 : 0x2ecc71) : 0x7f8c8d,
    description: tally.map(([n, c]) => `${n}  **${c}**`).join("\n") + (buys.length > 10 ? "\n-# Cards for the top 10 buys; the rest are in the CSV." : "") }];
  for (const x of buys.slice(0, 10)) embeds.push(analyseEmbed({ ...x.e, warnings: x.e.warnings || [], graph: job.origin ? await graphUrl(env, job.origin, x.asin) : null }));
  for (const [name, color, items, fmt, sep] of groups) {
    if (!items.length) continue;
    let cur = [], part = 0;
    const push = () => { embeds.push({ title: `${name} · ${items.length}${part ? " (cont.)" : ""}`, color, description: cur.join(sep) }); cur = []; part++; };
    for (const l of items.map((x) => fmt(x))) { if ((cur.join(sep) + l).length > 3600) push(); cur.push(l); }
    if (cur.length) push();
  }
  const msgs = []; let batch = [], size = 0;
  for (const e of embeds) {
    const len = (e.title || "").length + (e.description || "").length + 300;
    if (batch.length && (batch.length >= 10 || size + len > 5500)) { msgs.push(batch); batch = []; size = 0; }
    batch.push(e); size += len;
  }
  if (batch.length) msgs.push(batch);
  for (let n = 0; n < msgs.length; n++) {
    const body = { content: n === 0 ? `<@${job.user}>` : "", embeds: msgs[n], allowed_mentions: { users: n === 0 ? [job.user] : [] } };
    try { await dc(env, "POST", `/channels/${job.channel}/messages`, body); } catch (e) { await sleep(3000); await dc(env, "POST", `/channels/${job.channel}/messages`, body).catch(() => {}); }
  }
  const head = ["ASIN", "Title", "Buy", "BuyBox", "Profit", "ROI%", "Score", "RequiredROI%", "MaxBuy", "MaxBuyFloor", "SuggestedQty", "SalesPerMonth", "Sellers", "AmazonBBShare%", "Gated", "MinPrice", "Warnings"];
  const csv = [head.join(",")].concat(rows.map((x) => [x.asin, x.t, x.buy, x.bb, x.p, x.r != null ? x.r * 100 : null, x.sc, x.req != null ? x.req * 100 : null, x.mr, x.mf, x.q, x.mo, x.fba, x.az != null ? x.az * 100 : null, x.g ? "yes" : "", x.mp, x.err || x.w].map(csvCell).join(","))).join("\n");
  await dcFile(env, job.channel, "📎 Full results (opens in Excel / Sheets):", `analysis-${today()}.csv`, csv).catch(() => {});
}
async function bulkRun(env) {
  if (!env.BOT_KV) return "bulk: no BOT_KV binding";
  const st = await bulkState(env);
  if (!st.jobs.length) return "bulk: nothing queued";
  if (st.lockUntil && Date.parse(st.lockUntil) > Date.now()) return "bulk: another run is working";
  st.lockUntil = new Date(Date.now() + 55000).toISOString(); await bulkSave(env, st);
  const c = cfg(env), t0 = Date.now(); let n = 0;
  const spTok = hasSpapi(env) ? await spToken(env).catch(() => null) : null;
  while (st.jobs.length && n < c.bulkPerRun && Date.now() - t0 < 40000) {
    const job = st.jobs[0], it = job.items[job.done.length];
    if (!it) { await bulkFinish(env, job); st.jobs.shift(); continue; }
    try {
      const a = await analyseAsin(env, it.asin, it.buy, spTok, job.over || {});
      job.done.push(bulkRow(a, it));
      n++;
      if (a.tokensLeft != null && a.tokensLeft < 5) break;   // Keepa tokens low: carry on next minute
    } catch (e) {
      if (/out of tokens/.test(e.message)) break;
      job.done.push({ asin: it.asin, buy: it.buy, err: e.message.slice(0, 120) }); n++;
    }
    await sleep(600);
  }
  if (st.jobs.length && st.jobs[0].done.length >= st.jobs[0].items.length) { await bulkFinish(env, st.jobs[0]); st.jobs.shift(); }
  st.lockUntil = null; await bulkSave(env, st);
  return `bulk: ${n} analysed, ${st.jobs.reduce((s, j) => s + j.items.length - j.done.length, 0)} left`;
}

// ---------------------------------------------------------------- commands
const COMMANDS = [
  { name: "analyse", description: "A2A deal check: score an Amazon UK product 0-5", options: [
    { type: 3, name: "asin", description: "ASIN, e.g. B0AAAAAAA1 (or an Amazon link)", required: true },
    { type: 10, name: "buy", description: "Buy price per unit, £ inc VAT (optional: you can add it after)", required: false }] },
  { name: "analyse_bulk", description: "Analyse a list of ASINs (paste them or attach a CSV); results post here when done", options: [
    { type: 3, name: "list", description: "ASINs with optional buy prices, e.g. B0AAAAAAA1 12.99, B0AAAAAAA2 8.50", required: false },
    { type: 11, name: "file", description: "CSV or text file with ASIN and buy price columns", required: false }] },
  { name: "analyse_rules", description: "Show the rules your deals are scored with" },
  { name: "analyse_settings", description: "Set your own costs and rules (only affects your lookups). Run with no options to see them.", options: [
    { type: 10, name: "prep_fee", description: "Your prep cost per unit in £, e.g. 0.45", required: false, min_value: 0 },
    { type: 5, name: "vat_registered", description: "Are you VAT-registered?", required: false },
    { type: 10, name: "min_profit", description: "Minimum profit per unit in £ (below this = Skip)", required: false, min_value: 0 },
    { type: 10, name: "target_profit", description: "Profit in £ needed for a Buy (4/5)", required: false, min_value: 0 },
    { type: 3, name: "roi_ladder", description: "Required ROI % by sales/month, e.g. 10:80, 15:30, 20:20, 50:17, 100:15", required: false },
    { type: 10, name: "unknown_sales_roi", description: "ROI % needed when sales are unknown, e.g. 20", required: false, min_value: 0 },
    { type: 10, name: "min_price_roi", description: "ROI % used for the Min price figure, e.g. 15", required: false, min_value: 0 },
    { type: 10, name: "inbound_per_kg", description: "Shipping to Amazon per kg in £, e.g. 0.30", required: false, min_value: 0 },
    { type: 10, name: "storage_per_cuft", description: "FBA storage per cubic foot per month in £, e.g. 1.10", required: false, min_value: 0 },
    { type: 5, name: "reset", description: "Go back to the server defaults", required: false }] },
];
async function registerCommands(env) {
  if (!env.DISCORD_APP_ID || !env.DISCORD_BOT_TOKEN) return "Set DISCORD_APP_ID and DISCORD_BOT_TOKEN first.";
  await dc(env, "PUT", `/applications/${env.DISCORD_APP_ID}/commands`, COMMANDS);
  return `Registered: ${COMMANDS.map((x) => "/" + x.name).join(" ")}\nInvite the bot: https://discord.com/oauth2/authorize?client_id=${env.DISCORD_APP_ID}&scope=bot+applications.commands&permissions=51200`;
}
function rulesText(env, over = {}) {
  const c = cfg(env, over), p = (x) => Math.round(x * 1000) / 10 + "%";
  const mine = Object.keys(over).filter((k) => PERSONAL.includes(k));
  return [
    mine.length ? `**Your rules** (your own settings: ${mine.map((k) => k.toLowerCase()).join(", ")}; the rest are the server's)` : "**How deals are scored** (server defaults: change yours with /analyse_settings)",
    `Required ROI by sales per month: ${c.ladder.length ? `under ${c.ladder[0][0]}/mo = skip · ` : ""}${c.ladder.map(([m, r]) => `${m}+/mo → ${p(r)}`).join(" · ")} · unknown → ${p(c.unknownRoi)}`,
    `Profit: at least ${gbp2(c.minProfit)}, target ${gbp2(c.targetProfit)}`,
    `💎 5 Strong buy: ROI ${p(c.strongRoiMargin)} over what it needs, ${gbp2(c.strongProfit)}+ profit, ${c.strongSales}+/mo, no warnings · 🟢 4 Buy: meets ROI and target · 🟡 3 Maybe: meets ROI under target, or a 4 with a warning (price spike, price fell last season, sellers piling in) or unknown sales · 🔴 1 Skip · ⛔ 0 Loss`,
    `Costs: ${c.vat ? "VAT-registered (output VAT taken off the sale, VAT on your buy reclaimed)" : "not VAT-registered"} · prep ${gbp2(c.prep)} · inbound ${gbp2(c.inboundKg)}/kg · storage ${gbp2(c.storageCuft)}/cu ft`,
    `Q4: ${c.q4LastYear ? "uses last Q4's sales when they were faster" : "off"} · Min price = lowest sale price for ${p(c.minPriceRoi)} ROI and ${gbp2(c.minProfit)} profit`,
    `Data: Keepa${hasSpapi(env) ? " + Amazon (live offers, fees, gating)" : " only (fees estimated, gating not checked)"}`,
    "-# Estimates only. Always check before buying.",
  ].join("\n");
}

async function interaction(req, env, ctx) {
  const body = await req.text();
  if (!(await verifyDiscord(req, body, env.DISCORD_PUBLIC_KEY))) return new Response("bad signature", { status: 401 });
  const i = JSON.parse(body);
  if (i.type === 1) return json({ type: 1 });
  const c = cfg(env), origin = new URL(req.url).origin;
  const denied = accessError(i, c);
  if (denied) return json({ type: 4, data: { content: denied, flags: 64 } });
  const userId = i.member.user.id;
  const edit = (r) => dc(env, "PATCH", `/webhooks/${i.application_id}/${i.token}/messages/@original`, { content: r.content || "", embeds: r.embeds || [], components: r.components || [], allowed_mentions: { parse: [] } }).catch(() => {});
  const limited = async (n) => { const left = await useQuota(env, c, userId, n); return left < 0 ? `You've used your ${c.dailyLimit} lookups for today. Try again tomorrow.` : null; };

  if (i.type === 3 && String(i.data.custom_id || "").startsWith("an|buy|")) return json(buyModal(String(i.data.custom_id).split("|")[2]));
  if (i.type === 5 && String(i.data.custom_id || "").startsWith("anm|")) {   // buy price entered on the card: analyse again
    const asin = String(i.data.custom_id).split("|")[1];
    const val = (((i.data.components || [])[0] || {}).components || [])[0] || {};
    const stop = await limited(1);
    if (stop) return json({ type: 4, data: { content: stop, flags: 64 } });
    ctx.waitUntil((async () => { let r; try { r = await analyseReply(env, origin, asin, val.value, await userSettings(env, userId)); } catch (e) { r = { content: "Analysis failed: " + e.message }; } await edit(r); })());
    return json({ type: 5 });
  }
  if (i.type !== 2) return json({ type: 6 });
  const opt = Object.fromEntries((i.data.options || []).map((o) => [o.name, o.value]));
  const n = i.data.name;
  if (n === "analyse_rules") return json({ type: 4, data: { content: rulesText(env, await userSettings(env, userId)), flags: 64 } });
  if (n === "analyse_settings") return json({ type: 4, data: { content: (await settingsCommand(env, userId, opt)).slice(0, 1990), flags: 64 } });
  if (n === "analyse") {
    const stop = await limited(1);
    if (stop) return json({ type: 4, data: { content: stop, flags: 64 } });
    ctx.waitUntil((async () => { let r; try { r = await analyseReply(env, origin, opt.asin, opt.buy, await userSettings(env, userId)); } catch (e) { r = { content: "Analysis failed: " + e.message }; } await edit(r); })());
    return json({ type: 5 });
  }
  if (n === "analyse_bulk") {
    ctx.waitUntil((async () => {
      try {
        if (!env.BOT_KV) return edit({ content: "Bulk analysis needs the BOT_KV storage set up (see README)." });
        let text = String(opt.list || "");
        const att = opt.file && i.data.resolved && i.data.resolved.attachments && i.data.resolved.attachments[opt.file];
        if (att) { if (att.size > 500000) return edit({ content: "That file is too big (max 500 KB)." }); text += "\n" + await (await fetch(att.url)).text(); }
        const items = parseBulk(text, c.bulkMax);
        if (!items.length) return edit({ content: "No ASINs found. Paste them like `B0AAAAAAA1 12.99, B0AAAAAAA2 8.50` or attach a CSV with ASIN and buy price columns." });
        const stop = await limited(items.length);
        if (stop) return edit({ content: stop + " (a bulk list counts one lookup per ASIN)" });
        const st = await bulkState(env);
        const ahead = st.jobs.reduce((s, j) => s + j.items.length - j.done.length, 0);
        st.jobs.push({ id: Date.now().toString(36), items, done: [], user: userId, channel: i.channel_id, origin, over: await userSettings(env, userId), at: new Date().toISOString() });
        await bulkSave(env, st);
        const mins = Math.ceil((ahead + items.length) / Math.max(1, c.bulkPerRun));
        return edit({ content: `📊 Queued **${items.length}** ASINs (${items.filter((x) => x.buy).length} with a buy price)${items.length >= c.bulkMax ? ` (max ${c.bulkMax} per list)` : ""}.${ahead ? ` ${ahead} ahead of them.` : ""} Results post here in about ${mins} min.` });
      } catch (e) { return edit({ content: "Failed: " + e.message }); }
    })());
    return json({ type: 5 });
  }
  return json({ type: 4, data: { content: "Unknown command.", flags: 64 } });
}

export default {
  async scheduled(ev, env) { await bulkRun(env).catch(() => {}); },   // awaited so the run isn't cut off early
  async fetch(req, env, ctx) {
    const url = new URL(req.url), path = url.pathname;
    if (req.method === "POST" && path === "/interactions") return interaction(req, env, ctx);
    const gm = req.method === "GET" && path.match(/^\/graph\/(B0[0-9A-Z]{8}|\d{9}[0-9X])\.png$/);
    if (gm) return keepaGraph(req, env, ctx, gm[1]);
    if (req.method === "GET" && path === "/register") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) return new Response("Not found", { status: 404 });
      try { return new Response(await registerCommands(env)); } catch (e) { return new Response("Failed: " + e.message, { status: 500 }); }
    }
    if (req.method === "GET" && path === "/") return new Response("A2A Analyse Bot is running. Point your Discord app's Interactions Endpoint URL at /interactions.");
    return new Response("Not found", { status: 404 });
  },
};
// exported for tests
export { settingsCommand, userSettings, analyseAsin, analyseEmbed, parseBulk, reqRoiFor, cfg, keepaFees, bulkRow, bulkFinish, bulkRun, rulesText, accessError };
