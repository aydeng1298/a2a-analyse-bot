#!/usr/bin/env node
// One-command setup: Cloudflare sign-in, storage, deploy, your keys, Discord commands.
// Run it again any time to change a key (leave an answer blank to keep what's there).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q) => (await rl.question(q)).trim();
const run = (args, opts = {}) => spawnSync("npx", ["--yes", "wrangler@4", ...args], { shell: process.platform === "win32", encoding: "utf8", ...opts });
const say = (s = "") => console.log(s);

say("\n=== A2A Analyse Bot setup ===\n");

// 1. Cloudflare sign-in
say("1/6  Checking your Cloudflare sign-in…");
const who = run(["whoami"], { stdio: "pipe" });
if (/not authenticated|You are not logged in/i.test((who.stdout || "") + (who.stderr || ""))) {
  say("     A browser window will open: sign in to Cloudflare (a free account is fine) and allow access.");
  run(["login"], { stdio: "inherit" });
}

// 2. Storage for bulk lists and daily limits
let toml = readFileSync("wrangler.toml", "utf8");
if (toml.includes("REPLACE_WITH_YOUR_KV_ID")) {
  say("2/6  Creating storage (Cloudflare KV)…");
  const kv = run(["kv", "namespace", "create", "BOT_KV"], { stdio: "pipe" });
  const kvOut = (kv.stdout || "") + (kv.stderr || "");
  const id = kvOut.match(/id"?\s*[:=]\s*"([0-9a-f]{32})"/) ? [kvOut.match(/id"?\s*[:=]\s*"([0-9a-f]{32})"/)[1]] : kvOut.match(/\b[0-9a-f]{32}\b/);
  if (!id) { say((kv.stdout || "") + (kv.stderr || "")); say("Couldn't create the storage. Fix the error above and run `npm run setup` again."); process.exit(1); }
  toml = toml.replace("REPLACE_WITH_YOUR_KV_ID", id[0]);
  writeFileSync("wrangler.toml", toml);
  say("     Done.");
} else say("2/6  Storage already set up.");

// 3. Deploy
say("3/6  Deploying the bot to Cloudflare…");
const dep = run(["deploy"], { stdio: "pipe" });
const depOut = (dep.stdout || "") + (dep.stderr || "");
const url = (depOut.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0];
if (dep.status !== 0 || !url) { say(depOut); say("Deploy failed. Fix the error above and run `npm run setup` again."); process.exit(1); }
say(`     Live at ${url}`);

// 4. Your keys
say("\n4/6  Your keys. They're stored as encrypted Cloudflare secrets, never in this folder or on GitHub.");
say("     Leave an answer blank to keep the value you set before.\n");
const secrets = {};
const put = async (name, label) => { const v = await ask(`     ${label}: `); if (v) secrets[name] = v; };
say("     From https://discord.com/developers/applications > your app:");
await put("DISCORD_APP_ID", "General Information > Application ID");
await put("DISCORD_PUBLIC_KEY", "General Information > Public Key");
await put("DISCORD_BOT_TOKEN", "Bot > Reset Token (copy the token)");
say("\n     From https://keepa.com/#!api :");
await put("KEEPA_API_KEY", "Keepa API access key");
say("\n     Amazon login (SP-API) is optional but recommended: live Buy Box and FBA seller count,");
say("     Amazon's own fee figures, and a check of whether YOUR account is gated for each product.");
const amz = (await ask("     Add your Amazon SP-API keys now? (y/n): ")).toLowerCase().startsWith("y");
if (amz) {
  await put("SPAPI_CLIENT_ID", "LWA client ID (amzn1.application-oa2-client…)");
  await put("SPAPI_CLIENT_SECRET", "LWA client secret");
  await put("SPAPI_REFRESH_TOKEN", "Refresh token (Atzr|…)");
  await put("SPAPI_SELLER_ID", "Your Seller ID / Merchant Token (Seller Central > Settings > Account Info)");
}
let setupKey = existsSync(".setup-key") ? readFileSync(".setup-key", "utf8").trim() : "";
if (!setupKey) { setupKey = randomBytes(18).toString("hex"); writeFileSync(".setup-key", setupKey); secrets.SETUP_KEY = setupKey; }

// 5. Save the keys
if (Object.keys(secrets).length) {
  say("\n5/6  Saving your keys to Cloudflare…");
  writeFileSync(".secrets.tmp.json", JSON.stringify(secrets));
  const sb = run(["secret", "bulk", ".secrets.tmp.json"], { stdio: "pipe" });
  unlinkSync(".secrets.tmp.json");
  if (sb.status !== 0) { say((sb.stdout || "") + (sb.stderr || "")); say("Saving the keys failed. Run `npm run setup` again."); process.exit(1); }
  say("     Saved.");
} else say("\n5/6  No key changes.");

// 6. Register the slash commands
say("6/6  Registering the /analyse commands with Discord…");
await new Promise((r) => setTimeout(r, 4000));   // give the new secrets a moment
let reg = "";
try { reg = await (await fetch(`${url}/register?key=${setupKey}`)).text(); } catch (e) { reg = "Failed: " + e.message; }
say("     " + reg.replace(/\n/g, "\n     "));

say(`
=== Nearly done: two clicks in Discord ===
1. https://discord.com/developers/applications > your app > General Information
   Paste this into "Interactions Endpoint URL" and press Save:
     ${url}/interactions
2. Invite the bot to your server with the invite link above (if you haven't already).

Then type /analyse in your server. Change your rules in wrangler.toml and run \`npm run deploy\`.
`);
rl.close();
