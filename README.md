# A2A Analyse Bot

A Discord bot that scores Amazon UK products for **Amazon-to-Amazon (A2A) and online arbitrage** buying. Type `/analyse` with an ASIN and a buy price and you get a colour-coded card back:

```
🟢 4/5 Buy · Product name
💷  £9.00 → £2.50 profit · 27.8% ROI
📈  Buy Box £19.99 (90d avg £20.00) · ~100/mo
👥  4 FBA · 5 offers (4 last month) · Amazon on (60% BB)
🎯  Max buy £10.17 · Qty 20 · Min price £18.32
⚠️  Variation listing: check you're buying the exact child ASIN
[Keepa · SAS · Amazon]   + a 90-day Keepa price graph
```

It runs on **your own** free Cloudflare account with **your own** keys. Nobody else's keys, usage or data are involved, and nothing is sent anywhere except Keepa, Amazon and Discord.

- **Score 0–5** from your own rules: required ROI by sales per month, minimum and target profit.
- **Max buy price** for your rules, and a **suggested quantity** (about a month's sales split between the sellers on the listing).
- **Min price** for your repricer: the lowest sale price that still makes your minimum ROI and profit.
- **Seasonal check**: in Q4 it looks at last year's Q4, otherwise the same time last year. If prices fell back then, or last Q4 sold faster, it takes that into account.
- **Warnings**: price spike, sellers piling in, variation listing, hazmat, one seller owning the Buy Box (brand or private label risk), gated for your account.
- **Bulk analysis**: paste a list of ASINs (with buy prices) or attach a CSV. You get a ranked summary, full cards for the best buys and a CSV of everything.

UK marketplace (amazon.co.uk) only.

**Prefer a step-by-step guide?** Download the [Setup Guide (PDF)](docs/A2A-Analyse-Bot-Setup-Guide.pdf).

**Stuck?** This is a free tool with **no personal support**. Copy the [AI setup helper prompt](docs/AI-SETUP-HELPER.md) into Claude, ChatGPT, Gemini or any AI assistant, and it'll walk you through every step and explain any error.

---

## What it costs

| | Cost |
|---|---|
| Cloudflare Workers (runs the bot) | Free plan is enough for normal use |
| Discord bot | Free |
| **Keepa API** | **Required. From about €49/month** (keepa.com/#!api). A normal Keepa Pro subscription only includes 1 API token a minute: fine for testing, too slow for real use. |
| Amazon SP-API | Free (optional, needs a Professional seller account) |

Each lookup uses roughly 2–4 Keepa tokens: the product data, the Buy Box history and the graph.

---

## Amazon login: optional, but recommended

The bot works with Keepa alone. If you also connect your own Amazon Selling Partner API (SP-API) app, you get:

- **Gating check for your account.** It tells you if *you* need approval to sell the product, with a link to request it. Without it, the card says "Gating not checked".
- **Amazon's own fee figures** at the exact price. Keepa-only mode estimates fees from Keepa's referral % and FBA fee data, which is usually close but can be out of date.
- **Live Buy Box and the number of FBA sellers** right now. Keepa-only mode uses Keepa's latest data and counts all new offers (FBA and FBM together), so the suggested quantity is less accurate.

To use it you need a **Professional** seller account and must be the **primary user**. Amazon reviews your developer profile first, which can take a few days. You can set the bot up with Keepa only now and add Amazon later by running `npm run setup` again.

---

## Setup (about 20 minutes)

You need [Node.js](https://nodejs.org) 18 or newer and a terminal (Terminal on Mac, PowerShell on Windows).

### 1. Create the Discord bot
1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it whatever you like.
2. **General Information**: keep this page open. You'll copy the **Application ID** and **Public Key** in step 5.
3. **Bot** (left menu): click **Reset Token** and copy the token somewhere safe. You don't need any of the "Privileged Gateway Intents".

### 2. Get your Keepa API key
Subscribe to an API plan at <https://keepa.com/#!api>. Your access key is on the same page.

### 3. (Optional) Get your Amazon SP-API keys
1. In Seller Central (as the primary user) go to **Apps and Services > Develop Apps** and fill in the developer profile. Choose **Private developer: I build application(s) that integrate my own company**. Tick the **Product Listing** and **Pricing** roles.
2. Once approved, click **Add new app client**. Choose API type **SP API** and the same roles.
3. Open the app's **LWA credentials** and copy the **client ID** and **client secret**.
4. Click **Authorize app** (the arrow next to the app) to self-authorise it, and copy the **refresh token** (starts `Atzr|`).
5. Your **Seller ID** (Merchant Token) is in **Settings > Account Info > Your Merchant Token**.

### 4. Download this project
Click the green **Code** button above, then **Download ZIP**, and unzip it. Or, if you use git:
```
git clone https://github.com/aydeng1298/a2a-analyse-bot.git
```
Open a terminal in the folder.

### 5. Run the setup
```
npm run setup
```
It will:
1. sign you in to Cloudflare (a browser window opens; a free account is fine),
2. create the storage it needs,
3. deploy the bot,
4. ask for your keys and save them as encrypted Cloudflare secrets (never in the folder, never on GitHub),
5. register `/analyse`, `/analyse_bulk`, `/analyse_settings` and `/analyse_rules` with Discord, and print an **invite link**.

### 6. Connect Discord to the bot
1. Back on your app's **General Information** page, paste the address the setup printed (it ends in `/interactions`) into **Interactions Endpoint URL** and click **Save Changes**. Discord checks it straight away; if it saves, it's working.
2. Open the **invite link** from the setup and add the bot to a server you own or manage. The bot doesn't work in DMs. No server of your own? In Discord click **+** at the bottom of your server list > **Create My Own** > **For me and my friends**, and you have a private one in seconds.

Type `/analyse` in your server. Done.

---

## Using it

| Command | What it does |
|---|---|
| `/analyse asin:B0… buy:12.99` | Scores one product. Leave out `buy` to see the max buy price, then tap **Enter buy price**. **Try another price** re-scores it at a different price. |
| `/analyse_bulk list:B0AAAAAAA1 12.99, B0AAAAAAA2 8.50` | Analyses a list. You can also attach a CSV (see `examples/bulk-example.csv`); any columns work as long as each row has the ASIN, then the buy price. Results post in the same channel when done, about 4 ASINs a minute on the free plan. |
| `/analyse_settings` | Sets **your own** prep fee, VAT status, profit targets and ROI ladder, right in Discord. They only apply to your lookups. Run it with no options to see your settings, or `reset:True` to go back to the defaults. |
| `/analyse_rules` | Shows the rules your deals are scored with (only you see it). |

**Scores:** 💎 5 Strong buy · 🟢 4 Buy · 🟡 3 Maybe · 🔴 1 Skip · ⛔ 0 Loss.
- 🟢 **Buy** = meets the ROI it needs for its sales speed, and your target profit.
- 💎 **Strong buy** = comfortably beats it, sells well, and has no warnings.
- 🟡 **Maybe** = meets your ROI but is under target profit. A 4 also drops to Maybe if it has a warning (price spike, price fell last season, sellers piling in) or unknown sales.

The numbers are estimates in the same spirit as SellerAmp SAS. Always double-check before buying.

---

## Your rules

There are two ways to set them.

**1. In Discord, for yourself: `/analyse_settings`.** No files or terminal needed, and each person in a server can have their own:
```
/analyse_settings prep_fee:0.45 vat_registered:True min_profit:1.50 target_profit:2.50
/analyse_settings roi_ladder:10:80, 15:30, 20:20, 50:17, 100:15
```
- **ROI ladder:** `sales per month : ROI %`, separated by commas. Anything selling less than the first number is a Skip.
- **Percentages:** you can type `20` or `0.20` for 20%.
- **Changeable here:** prep fee, inbound per kg, storage per cubic foot, VAT registered, minimum and target profit, ROI ladder, ROI when sales are unknown, and the Min price ROI.

**2. Server defaults, for everyone who hasn't set their own:** these are in **`wrangler.toml`** under `[vars]`, each with a note explaining it. Change them, then run:
```
npm run deploy
```

| Setting | Default | Meaning |
|---|---|---|
| `VAT_REGISTERED` | `true` | VAT-registered: output VAT comes off the sale and VAT on your buy and fees is reclaimed |
| `PREP_FEE` | `0.38` | Prep cost per unit (£) |
| `INBOUND_PER_KG` | `0.30` | Shipping to Amazon per kg (£) |
| `STORAGE_PER_CUFT` | `1.10` | FBA storage per cubic foot per month (£) |
| `ROI_LADDER` | `10:0.80,15:0.30,20:0.20,50:0.17,100:0.15` | Required ROI by sales/month. Under the first number = skip |
| `UNKNOWN_SALES_ROI` | `0.20` | ROI needed when sales are unknown |
| `MIN_PROFIT` / `TARGET_PROFIT` | `1.00` / `2.00` | Minimum profit, and the profit needed for a 4 |
| `STRONG_ROI_MARGIN` / `STRONG_PROFIT` / `STRONG_SALES` | `0.10` / `3.00` / `30` | What it takes to be a 5 |
| `MIN_PRICE_ROI` | `0.15` | ROI used for the "Min price" figure |
| `Q4_USE_LAST_YEAR` | `true` | In Oct–Dec, use last Q4's sales if they were faster |
| `FALLBACK_FBA_FEE` | `3.00` | Keepa-only mode: FBA fee to assume if Keepa doesn't know it |

### Sharing it in a community server
| Setting | Meaning |
|---|---|
| `ALLOWED_ROLE_IDS` | Only people with one of these roles can use it (blank = everyone) |
| `ALLOWED_CHANNEL_IDS` | Only works in these channels (blank = any) |
| `ADMIN_USER_IDS` | These people skip the limits |
| `DAILY_LIMIT` | Lookups per person per day (`0` = unlimited). Protects your Keepa tokens |
| `BULK_MAX` | Most ASINs in one bulk list |
| `BULK_PER_RUN` | ASINs analysed per minute. Keep `4` on Cloudflare's free plan; up to `20` on Workers Paid ($5/month) |

To copy an ID, turn on **Developer Mode** in Discord (Settings > Advanced), then right-click a role, channel or user and choose **Copy ID**.

Remember: everyone in your server uses **your** Keepa tokens, and the gating check is for **your** Amazon account. Set a `DAILY_LIMIT` before opening it up.

---

## Updating
Back up your `wrangler.toml` (it holds your rules and your storage ID), download the new version, put your `wrangler.toml` back, and run `npm run setup` (leave every key blank to keep them). That also picks up any new commands.

## Troubleshooting
Still stuck after this list? Use the [AI setup helper prompt](docs/AI-SETUP-HELPER.md): paste it into any AI assistant along with the error.

- **Discord won't save the Interactions Endpoint URL**: the Public Key or Application ID is wrong. Run `npm run setup` again and re-enter them.
- **"The application did not respond"**: run `npm run logs` in the folder, try the command again, and read the error.
- **"Keepa is out of tokens"**: wait a few minutes, or lower `DAILY_LIMIT` / `BULK_PER_RUN`.
- **"Amazon sign-in failed"**: re-copy your SP-API refresh token (run `npm run setup`, answer `y` to Amazon keys).
- **Changed a key?** Run `npm run setup` again. Leave the others blank to keep them.

## Privacy and security
- Keys are stored as encrypted Cloudflare secrets on your account. They're never written to this folder or sent anywhere except the service they belong to.
- The Keepa graph is fetched by your worker, so your Keepa key never appears in Discord. Graph links are signed, so nobody can use your worker to spend your tokens.
- Nothing about your lookups is stored, except a bulk list while it's being worked through and the daily-limit counters (both in your own Cloudflare storage).

## Disclaimer
Not affiliated with or endorsed by Amazon, Keepa, SellerAmp or Discord. All figures are estimates and can be wrong or out of date; check everything before you buy. Use at your own risk and within the terms of Keepa, Amazon's SP-API and Discord.

## Licence
MIT. See [LICENSE](LICENSE).
