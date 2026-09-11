import type { SeranoxClient, TrackedWallet } from "@seranox/sdk";
import type { RelayConfig } from "./config.js";
import { matchDislocation, matchNewPair, matchWalletUpdate, type Alert } from "./rules.js";
import type { Transport } from "./transport.js";

export interface RelayOptions {
  config: RelayConfig;
  client: SeranoxClient;
  transport: Transport;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Per-destination sliding-window throttle. */
class Throttle {
  private readonly sent = new Map<string, number[]>();
  constructor(private readonly perMinute: number, private readonly now: () => number) {}
  allow(dest: string): boolean {
    const t = this.now();
    const arr = (this.sent.get(dest) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= this.perMinute) {
      this.sent.set(dest, arr);
      return false;
    }
    arr.push(t);
    this.sent.set(dest, arr);
    return true;
  }
}

function inQuietHours(q: { start: string; end: string } | undefined, now: number): boolean {
  if (!q) return false;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = q.start.split(":").map(Number);
  const [eh, em] = q.end.split(":").map(Number);
  const s = sh! * 60 + sm!, e = eh! * 60 + em!;
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}

/**
 * The relay loop: poll → match rules → dedupe → quiet hours → throttle → send.
 * Whitepaper #6: alert bot seats are per tier; the throttle keeps each seat honest.
 */
export class Relay {
  private readonly seen = new Set<string>();
  private readonly wallets = new Map<string, TrackedWallet>();
  private readonly throttle: Throttle;
  private first = true;
  readonly stats = { polls: 0, matched: 0, sent: 0, deduped: 0, throttled: 0, quiet: 0, seraBurned: 0 };

  constructor(private readonly o: RelayOptions) {
    this.throttle = new Throttle(o.config.throttlePerMinute, o.now ?? Date.now);
  }

  async poll(): Promise<Alert[]> {
    const { config, client } = this.o;
    const now = (this.o.now ?? Date.now)();
    const alerts: Alert[] = [];
    this.stats.polls += 1;
    const kinds = new Set(config.rules.map((r) => r.kind));

    if (kinds.has("new_pair")) {
      const res = await client.pairs.list({ sort: "new" });
      for (const p of res.data) for (const r of config.rules) if (r.kind === "new_pair") { const a = matchNewPair(r, p); if (a) alerts.push(a); }
    }
    if (kinds.has("wallet_trade")) {
      const res = await client.wallets.list();
      for (const w of res.data) {
        const prev = this.wallets.get(w.address);
        this.wallets.set(w.address, w);
        for (const r of config.rules) if (r.kind === "wallet_trade") { const a = matchWalletUpdate(r, w, prev); if (a) alerts.push(a); }
      }
    }
    if (kinds.has("dislocation")) {
      const res = await client.equities.dislocation();
      const bucket = Math.floor(now / (30 * 60_000)); // one alert per ticker per 30 minutes
      for (const e of res.data) for (const r of config.rules) if (r.kind === "dislocation") { const a = matchDislocation(r, e, bucket); if (a) alerts.push(a); }
    }
    this.stats.seraBurned = client.usage.seraBurned;

    const fresh: Alert[] = [];
    for (const a of alerts) {
      if (this.seen.has(a.id)) { this.stats.deduped += 1; continue; }
      this.seen.add(a.id);
      if (this.first && a.rule && !a.id.includes(":" + String(Math.floor(now / (30 * 60_000))))) continue; // warm-up: don't replay history
      fresh.push(a);
    }
    this.first = false;
    this.stats.matched += fresh.length;

    if (inQuietHours(config.quietHours, now)) { this.stats.quiet += fresh.length; return []; }
    const sent: Alert[] = [];
    for (const a of fresh) {
      for (const name of a.to) {
        const dest = config.destinations.find((d) => d.name === name);
        if (!dest) continue;
        if (!this.throttle.allow(name)) { this.stats.throttled += 1; continue; }
        try {
          await this.o.transport.send(dest, `[${a.rule}] ${a.text}`);
          this.stats.sent += 1;
        } catch (err) {
          this.o.log?.(`send failed: ${String(err)}`);
        }
      }
      sent.push(a);
    }
    return sent;
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        await this.poll();
      } catch (err) {
        this.o.log?.(`poll failed: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, this.o.config.pollSeconds * 1000));
    }
  }
}
