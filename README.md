# @seranox/relay

Self-hosted alert relay for **Seranox**. Poll the metered API, match YAML rules, and push to **Telegram**, **Discord**, or any **webhook** — with dedupe, per-destination throttling, quiet hours, and a $SERA credit guard.

Whitepaper utility #6 (alert bot seats) for people who want the relay under their own control: trading groups (#12 team seats), agents, or anyone running their own bot token.

```bash
pnpm add -g @seranox/relay        # or clone and pnpm build
cp relay.example.yaml relay.yaml  # edit rules; secrets via ${ENV} placeholders
SERANOX_API_URL=… TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… seranox-relay --config relay.yaml
```

Flags: `--once` (warm up, poll once, print stats), `--dry-run` (print instead of sending).

## Rules

| kind | matches | filters |
|---|---|---|
| `new_pair` | a pair appears on the tape | `risk`, `minLiquidityUsd`, `maxAgeMin`, `maxTop10Pct`, `excludeSponsored` (default true) |
| `wallet_trade` | a tracked wallet's trade count changes | `wallets` (labels/addresses; empty = all), `minAmountUsd` (30d PnL delta) |
| `dislocation` | \|on-chain vs last close\| crosses a threshold | `tickers`, `minAbsSpreadPct` (one alert per ticker per 30 min) |

```yaml
pollSeconds: 30
throttlePerMinute: 20               # per destination
quietHours: { start: "02:00", end: "06:00" }
destinations:
  - { type: telegram, name: tg, botToken: ${TELEGRAM_BOT_TOKEN}, chatId: ${TELEGRAM_CHAT_ID} }
  - { type: discord,  name: dc, webhookUrl: ${DISCORD_WEBHOOK_URL} }
rules:
  - { kind: new_pair, name: clean-launches, to: [tg, dc], risk: [clean], minLiquidityUsd: 50000, maxAgeMin: 15 }
  - { kind: dislocation, name: overnight-gap, to: [dc], tickers: [TSLA, HOOD], minAbsSpreadPct: 2 }
```

Behaviour: the first poll is a **warm-up** (history is never replayed); every alert has a stable id so restarts don't double-send within a run; `throttlePerMinute` caps each destination; quiet hours drop alerts entirely; `api.budgetSeraPerHour` stops polling before the indexer bill runs away.

## Develop

Depends on `@seranox/sdk` via `file:../seranox-sdk` (sibling folder; CI builds it first).

```bash
pnpm install && pnpm test && pnpm lint && pnpm typecheck && pnpm build
pnpm dev   # dry run against relay.example.yaml
```

MIT.
