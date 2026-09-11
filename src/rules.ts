import type { Equity, Pair, TrackedWallet } from "@seranox/sdk";
import type { Rule } from "./config.js";

export interface Alert {
  /** Stable id used for dedupe (rule + subject). */
  id: string;
  rule: string;
  to: string[];
  text: string;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

export function matchNewPair(rule: Extract<Rule, { kind: "new_pair" }>, p: Pair): Alert | null {
  if (rule.risk && !rule.risk.includes(p.risk)) return null;
  if (rule.minLiquidityUsd !== undefined && p.liquidityUsd < rule.minLiquidityUsd) return null;
  if (rule.maxAgeMin !== undefined && p.ageMin > rule.maxAgeMin) return null;
  if (rule.maxTop10Pct !== undefined && p.top10Pct > rule.maxTop10Pct) return null;
  if (rule.excludeSponsored && p.sponsored) return null;
  return {
    id: `${rule.name}:${p.id}`,
    rule: rule.name,
    to: rule.to,
    text: `🆕 $${p.symbol} (${p.name}) · ${p.ageMin}m old · liq ${usd(p.liquidityUsd)} · mcap ${usd(p.mcapUsd)} · 1h ${pct(p.change1h)} · top10 ${p.top10Pct}% · risk ${p.risk}${p.riskFlags.length ? ` (${p.riskFlags.join(", ")})` : ""}\n${p.address}`,
  };
}

export function matchWalletUpdate(rule: Extract<Rule, { kind: "wallet_trade" }>, w: TrackedWallet, prev: TrackedWallet | undefined): Alert | null {
  if (!prev) return null;
  if (rule.wallets.length && !rule.wallets.some((x) => x.toLowerCase() === w.label.toLowerCase() || x.toLowerCase() === w.address.toLowerCase())) return null;
  const deltaTrades = w.trades30d - prev.trades30d;
  const deltaPnl = w.pnl30dUsd - prev.pnl30dUsd;
  if (deltaTrades <= 0) return null;
  if (Math.abs(deltaPnl) < rule.minAmountUsd) return null;
  return {
    id: `${rule.name}:${w.address}:${w.trades30d}`,
    rule: rule.name,
    to: rule.to,
    text: `👛 ${w.label} traded ×${deltaTrades} · 30d PnL ${deltaPnl >= 0 ? "+" : ""}${usd(deltaPnl)} → ${usd(w.pnl30dUsd)} · win ${w.winRate}% · tags ${w.tags.join("/")}`,
  };
}

export function matchDislocation(rule: Extract<Rule, { kind: "dislocation" }>, e: Equity, bucket: number): Alert | null {
  if (rule.tickers.length && !rule.tickers.map((t) => t.toUpperCase()).includes(e.ticker)) return null;
  if (Math.abs(e.spreadPct) < rule.minAbsSpreadPct) return null;
  return {
    // one alert per ticker per time bucket so a persistent spread doesn't spam every poll
    id: `${rule.name}:${e.ticker}:${bucket}`,
    rule: rule.name,
    to: rule.to,
    text: `📉 ${e.ticker} on-chain $${e.onchainUsd.toFixed(2)} vs close $${e.lastCloseUsd.toFixed(2)} (${pct(e.spreadPct)}) · netflow ${usd(e.netFlow24hUsd)} · accum/distrib ${e.accumulators}/${e.distributors} · read-only`,
  };
}
