#!/usr/bin/env node
import { SeranoxClient } from "@seranox/sdk";
import { loadConfig } from "./config.js";
import { Relay } from "./relay.js";
import { ConsoleTransport, FetchTransport } from "./transport.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1]! : d; };

const config = loadConfig(opt("--config", "relay.yaml"));
const client = new SeranoxClient({ baseUrl: config.api.baseUrl, apiKey: config.api.apiKey, budget: { maxSera: config.api.budgetSeraPerHour } });
const relay = new Relay({ config, client, transport: flag("--dry-run") ? new ConsoleTransport() : new FetchTransport(), log: console.error });

console.error(`seranox-relay: ${config.rules.length} rules → ${config.destinations.map((d) => d.name).join(", ")} · every ${config.pollSeconds}s${flag("--dry-run") ? " · DRY RUN" : ""}`);
if (flag("--once")) {
  await relay.poll(); // warm-up
  const sent = await relay.poll();
  console.error(JSON.stringify({ ...relay.stats, sentNow: sent.length }));
} else {
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  await relay.run(ac.signal);
}
