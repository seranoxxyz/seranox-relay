import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SeranoxClient, type Pair, type Equity } from "@seranox/sdk";

import { configSchema, loadConfig } from "../src/config.js";
import { Relay } from "../src/relay.js";
import type { Transport } from "../src/transport.js";
import type { Destination } from "../src/config.js";

const pair = (id: string, over: Partial<Pair> = {}): Pair => ({
  id, symbol: id.toUpperCase(), name: id, address: `0x${id}`, deployer: "0xd", ageMin: 5, priceUsd: 1, change5m: 0, change1h: 12, change24h: 0,
  liquidityUsd: 100_000, mcapUsd: 1e6, volume24hUsd: 5e5, holders: 100, top10Pct: 15, risk: "clean", riskFlags: [], ...over,
});
const eq = (ticker: string, spreadPct: number): Equity => ({ ticker, name: ticker, lastCloseUsd: 100, onchainUsd: 100 * (1 + spreadPct / 100), spreadPct, netFlow24hUsd: 1000, accumulators: 5, distributors: 2, volume24hUsd: 1e6 });

function fakeClient(state: { pairs: Pair[]; equities: Equity[]; wallets: Array<{ address: string; label: string; trades30d: number; pnl30dUsd: number; winRate: number; tags: string[] }> }) {
  const f: typeof fetch = (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace("/v1", "");
    const j = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { "x-sera-burned": "1" } }));
    if (path === "/pairs") return j(state.pairs);
    if (path === "/wallets") return j(state.wallets);
    if (path === "/equities/dislocation") return j(state.equities);
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
  return new SeranoxClient({ baseUrl: "https://api.test/v1", fetch: f });
}

class MemTransport implements Transport {
  sent: Array<{ dest: string; text: string }> = [];
  send(dest: Destination, text: string) {
    this.sent.push({ dest: dest.name, text });
    return Promise.resolve();
  }
}

const baseConfig = configSchema.parse({
  pollSeconds: 5,
  throttlePerMinute: 2,
  destinations: [{ type: "webhook", name: "hook", url: "https://example.com/x" }],
  rules: [
    { kind: "new_pair", name: "clean", to: ["hook"], risk: ["clean"], minLiquidityUsd: 50_000, maxTop10Pct: 40 },
    { kind: "wallet_trade", name: "wallets", to: ["hook"], wallets: ["night_owl.eth"], minAmountUsd: 100 },
    { kind: "dislocation", name: "gap", to: ["hook"], minAbsSpreadPct: 2 },
  ],
});

describe("config", () => {
  it("loads YAML with env placeholders and validates destination names", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    const p = join(dir, "relay.yaml");
    writeFileSync(p, `destinations:\n  - { type: telegram, name: tg, botToken: \${TOKEN}, chatId: "1" }\nrules:\n  - { kind: new_pair, name: a, to: [tg] }\n`);
    const cfg = loadConfig(p, { TOKEN: "secret" });
    expect(cfg.destinations[0]).toMatchObject({ type: "telegram", botToken: "secret" });
    expect(cfg.api.baseUrl).toContain("seranox.xyz");
    writeFileSync(p, `destinations:\n  - { type: discord, name: dc, webhookUrl: https://d.example/w }\nrules:\n  - { kind: new_pair, name: a, to: [nope] }\n`);
    expect(() => loadConfig(p)).toThrow(/unknown destination/);
  });
});

describe("Relay", () => {
  it("warms up, then alerts on new matching pairs once (dedupe)", async () => {
    let t = 1_000_000;
    const state = { pairs: [pair("old")], equities: [eq("TSLA", 0.5)], wallets: [] };
    const transport = new MemTransport();
    const relay = new Relay({ config: baseConfig, client: fakeClient(state), transport, now: () => t });
    await relay.poll(); // warm-up
    expect(transport.sent).toHaveLength(0);
    state.pairs = [pair("fresh"), pair("dirty", { risk: "danger" }), pair("thin", { liquidityUsd: 1_000 }), pair("old")];
    t += 30_000;
    const sent = await relay.poll();
    expect(sent.map((a) => a.id)).toEqual(["clean:fresh"]);
    expect(transport.sent[0]!.text).toMatch(/\[clean\] 🆕 \$FRESH/);
    t += 30_000;
    expect(await relay.poll()).toHaveLength(0);
    expect(relay.stats.deduped).toBeGreaterThan(0);
  });

  it("fires wallet and dislocation rules, throttles per destination", async () => {
    let t = 5_000_000;
    const state = {
      pairs: [] as Pair[],
      equities: [eq("TSLA", 0.1)],
      wallets: [{ address: "0x1", label: "night_owl.eth", trades30d: 10, pnl30dUsd: 1000, winRate: 60, tags: [] }],
    };
    const transport = new MemTransport();
    const relay = new Relay({ config: baseConfig, client: fakeClient(state), transport, now: () => t });
    await relay.poll();
    state.wallets = [{ ...state.wallets[0]!, trades30d: 12, pnl30dUsd: 1900 }];
    state.equities = [eq("TSLA", 3.2), eq("HOOD", -2.5)];
    state.pairs = [pair("p1"), pair("p2"), pair("p3")];
    t += 30_000;
    const sent = await relay.poll();
    expect(sent.map((a) => a.rule).sort()).toEqual(["clean", "clean", "clean", "gap", "gap", "wallets"]);
    expect(transport.sent).toHaveLength(2); // throttlePerMinute = 2
    expect(relay.stats.throttled).toBe(4);
    t += 61_000;
    state.equities = [eq("TSLA", 3.3)]; // same 30-min bucket → deduped
    expect(await relay.poll()).toHaveLength(0);
  });

  it("holds everything during quiet hours", async () => {
    const cfg = { ...baseConfig, quietHours: { start: "00:00", end: "23:59" } };
    const state = { pairs: [] as Pair[], equities: [], wallets: [] };
    const transport = new MemTransport();
    const relay = new Relay({ config: cfg, client: fakeClient(state), transport, now: () => Date.now() });
    await relay.poll();
    state.pairs = [pair("q")];
    expect(await relay.poll()).toHaveLength(0);
    expect(relay.stats.quiet).toBe(1);
    expect(transport.sent).toHaveLength(0);
  });
});
