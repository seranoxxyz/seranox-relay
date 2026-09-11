import type { Destination } from "./config.js";

export interface Transport {
  send(dest: Destination, text: string): Promise<void>;
}

/** Real transports: Telegram Bot API, Discord webhooks, generic JSON webhooks. */
export class FetchTransport implements Transport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async send(dest: Destination, text: string): Promise<void> {
    let res: Response;
    if (dest.type === "telegram") {
      res = await this.fetchImpl(`https://api.telegram.org/bot${dest.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: dest.chatId, text, disable_web_page_preview: true }),
      });
    } else if (dest.type === "discord") {
      res = await this.fetchImpl(dest.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900) }) });
    } else {
      res = await this.fetchImpl(dest.url, { method: "POST", headers: { "content-type": "application/json", ...dest.headers }, body: JSON.stringify({ text, source: "seranox-relay" }) });
    }
    if (!res.ok) throw new Error(`${dest.type} ${dest.name} → HTTP ${res.status}`);
  }
}

/** Prints instead of sending — `--dry-run`. */
export class ConsoleTransport implements Transport {
  constructor(private readonly log: (s: string) => void = console.error) {}
  send(dest: Destination, text: string): Promise<void> {
    this.log(`[dry-run → ${dest.type}:${dest.name}] ${text}`);
    return Promise.resolve();
  }
}
