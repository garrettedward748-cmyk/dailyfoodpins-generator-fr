import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('telegram');

/**
 * Telegram notifications.
 *
 * Notification failures never fail a run. A published article whose
 * "it published" message did not send is still a published article.
 */
export class TelegramClient {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  private get configured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  async sendMessage(text: string): Promise<boolean> {
    if (!this.configured) return false;

    try {
      const response = await fetch(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        log.warn(`sendMessage failed: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (err) {
      log.warn('sendMessage failed', errorMessage(err));
      return false;
    }
  }

  async sendPhoto(photoUrl: string, caption: string): Promise<boolean> {
    if (!this.configured) return false;

    try {
      const response = await fetch(this.url('sendPhoto'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          photo: photoUrl,
          caption: caption.slice(0, 1024),
          parse_mode: 'HTML',
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        log.warn(`sendPhoto failed: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (err) {
      log.warn('sendPhoto failed', errorMessage(err));
      return false;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured) return { ok: false, error: 'Bot token or chat ID missing' };
    try {
      const response = await fetch(this.url('getMe'), { signal: AbortSignal.timeout(10_000) });
      return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
