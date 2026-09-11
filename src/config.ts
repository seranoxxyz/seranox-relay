import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const destination = z.discriminatedUnion("type", [
  z.object({ type: z.literal("telegram"), name: z.string(), botToken: z.string(), chatId: z.string() }),
  z.object({ type: z.literal("discord"), name: z.string(), webhookUrl: z.string().url() }),
  z.object({ type: z.literal("webhook"), name: z.string(), url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }),
]);

const rule = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new_pair"),
    name: z.string(),
    to: z.array(z.string()).min(1),
    risk: z.array(z.enum(["clean", "caution", "danger"])).optional(),
    minLiquidityUsd: z.number().optional(),
    maxAgeMin: z.number().optional(),
    maxTop10Pct: z.number().optional(),
    excludeSponsored: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("wallet_trade"),
    name: z.string(),
    to: z.array(z.string()).min(1),
    /** Labels or addresses. Empty = every tracked wallet. */
    wallets: z.array(z.string()).default([]),
    minAmountUsd: z.number().default(0),
  }),
  z.object({
    kind: z.literal("dislocation"),
    name: z.string(),
    to: z.array(z.string()).min(1),
    tickers: z.array(z.string()).default([]),
    minAbsSpreadPct: z.number().default(2),
  }),
]);

export const configSchema = z.object({
  api: z.object({ baseUrl: z.string().default("https://app.seranox.xyz/api/v1"), apiKey: z.string().optional(), budgetSeraPerHour: z.number().default(60) }).prefault({}),
  pollSeconds: z.number().min(5).default(30),
  /** Max messages per destination per minute (whitepaper #6: relay seats are throttled). */
  throttlePerMinute: z.number().default(20),
  /** Local hours during which nothing is sent, e.g. { start: "01:00", end: "06:00" }. */
  quietHours: z.object({ start: z.string(), end: z.string() }).optional(),
  destinations: z.array(destination).min(1),
  rules: z.array(rule).min(1),
});

export type RelayConfig = z.infer<typeof configSchema>;
export type Rule = RelayConfig["rules"][number];
export type Destination = RelayConfig["destinations"][number];

/** `${ENV_VAR}` placeholders are expanded so secrets stay out of the YAML. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const raw = readFileSync(path, "utf8").replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => env[k] ?? "");
  const cfg = configSchema.parse(parse(raw));
  const names = new Set(cfg.destinations.map((d) => d.name));
  for (const r of cfg.rules) for (const t of r.to) if (!names.has(t)) throw new Error(`Rule "${r.name}" targets unknown destination "${t}".`);
  return cfg;
}
