import { randomUUID } from 'node:crypto';
import type { AdapterContext, ChannelAdapter, InboundMessage } from './types.js';

/**
 * Website chat: there is no external platform to log in to. Visitors reach the server through the public widget API
 * (routes/widget.ts), which hands their messages to this adapter so the bot, flow, knowledge base, routing and inbox
 * behave exactly as for any other channel. Replies are stored as messages and picked up by the widget's long poll.
 */
export class WebChatAdapter implements ChannelAdapter {
  private active = false;
  constructor(private readonly ctx: AdapterContext) {}
  async start(): Promise<void> { this.active = true; this.ctx.events.onStatus('connected'); }
  async stop(): Promise<void> { this.active = false; this.ctx.events.onStatus('stopped'); }
  async logout(): Promise<void> { this.active = false; this.ctx.events.onStatus('logged_out'); }
  isActive(): boolean { return this.active; }
  async sendText(): Promise<{ externalMessageId?: string }> { return { externalMessageId: `wco-${randomUUID()}` }; }
  async ingest(m: InboundMessage): Promise<void> { await this.ctx.events.onMessage(m); }
}
