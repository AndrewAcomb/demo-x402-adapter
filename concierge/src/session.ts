/**
 * One browser connection = one concierge session.
 * Orchestrates: speech -> intent -> Bazaar discovery -> catalog browse ->
 * product choice -> voice confirmation -> x402 payment -> narrated fulfillment.
 */

import type { Config, ShippingAddress } from './config.js';
import { logError, redactSecrets } from './config.js';
import { discoverMerchant } from './discovery.js';
import { Brain } from './llm.js';
import { MerchantClient } from './merchant.js';
import type { PaymentRig } from './payment.js';
import type { ClientMsg, Intent, OrderEvent, Product, ServerMsg } from './types.js';
import { AsrSession, synthesize } from './voice.js';

const YES_RE = /\b(yes|yeah|yep|confirm|confirmed|go ahead|do it|buy it|sure|absolutely)\b/i;
const NO_RE = /\b(no|nope|cancel|stop|abort|never mind|don't)\b/i;

type State = 'idle' | 'working' | 'confirming' | 'fulfilling' | 'done';

export class Session {
  private state: State = 'idle';
  private asr?: AsrSession;
  private sayChain: Promise<void> = Promise.resolve();
  private merchant: MerchantClient;
  private pendingPurchase?: {
    product: Product;
    quantity: number;
    recipient: string;
    shipping: ShippingAddress;
    dryRun: boolean;
  };
  private pollTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private cfg: Config,
    private brain: Brain,
    private rig: PaymentRig,
    private send: (msg: ServerMsg) => void,
  ) {
    this.merchant = new MerchantClient(cfg.merchantUrl, rig.fetch);
    this.send({
      type: 'config',
      modes: {
        voice: cfg.mockVoice ? 'mock' : 'live',
        llm: cfg.mockLlm ? 'mock' : 'live',
        merchant: cfg.mockMerchant ? 'mock' : 'live',
        pay: rig.mode,
      },
      merchant_url: cfg.merchantUrl,
      dry_run: cfg.demoDryRun,
    });
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.asr?.close();
  }

  handleMessage(msg: ClientMsg): void {
    switch (msg.type) {
      case 'start_audio':
        this.startMic();
        break;
      case 'audio':
        this.asr?.sendAudio(msg.audio);
        break;
      case 'stop_audio':
        this.asr?.stop();
        this.send({ type: 'mic', state: 'idle' });
        break;
      case 'text_input':
        void this.handleUtterance(msg.text.trim());
        break;
      case 'confirm':
        void this.resolveConfirmation(true);
        break;
      case 'cancel':
        void this.resolveConfirmation(false);
        break;
      case 'reset':
        this.resetToIdle();
        break;
    }
  }

  // --- Voice plumbing --------------------------------------------------------

  private startMic(): void {
    if (this.cfg.mockVoice) {
      this.send({ type: 'error', message: 'Voice is mocked (MOCK_VOICE=1) — use the text box.' });
      return;
    }
    this.asr?.close();
    this.asr = new AsrSession(this.cfg, {
      onPartial: (text) => this.send({ type: 'transcript', text, final: false }),
      onFinal: (text) => void this.handleUtterance(text),
      onError: (message) => this.send({ type: 'error', message: redactSecrets(message) }),
    });
    this.asr.start();
    this.send({ type: 'mic', state: 'listening' });
  }

  /** Speak a line: queued sequentially so narration never overlaps. */
  private say(text: string): void {
    this.sayChain = this.sayChain
      .then(async () => {
        if (this.closed) return;
        const wav = await synthesize(this.cfg, text);
        this.send({
          type: 'say',
          text,
          ...(wav ? { audio_b64: wav.toString('base64') } : {}),
        });
      })
      .catch((e) => void logError('[session] say failed:', e));
  }

  // --- The buy pipeline ------------------------------------------------------

  private async handleUtterance(text: string): Promise<void> {
    if (!text) return;
    this.send({ type: 'transcript', text, final: true });

    if (this.state === 'confirming') {
      if (YES_RE.test(text) && !NO_RE.test(text)) return this.resolveConfirmation(true);
      if (NO_RE.test(text)) return this.resolveConfirmation(false);
      this.say('Please say yes to confirm the purchase, or no to cancel.');
      return;
    }
    if (this.state === 'working' || this.state === 'fulfilling') {
      this.send({ type: 'thought', text: 'Busy with the current order — utterance ignored.' });
      return;
    }
    if (this.state === 'done') this.resetToIdle();
    await this.runPipeline(text);
  }

  private async runPipeline(transcript: string): Promise<void> {
    this.state = 'working';
    try {
      // 1. Understand the request.
      this.send({ type: 'stage', name: 'understanding', detail: transcript });
      const addressKeys = Object.keys(this.cfg.addressBook);
      const intent = await this.brain.parseIntent(transcript, addressKeys);
      const shipping = this.cfg.addressBook[intent.recipient] ?? this.cfg.addressBook[addressKeys[0]];
      if (!shipping) {
        throw new Error('address book is empty — create concierge/addresses.json');
      }
      this.send({
        type: 'thought',
        text: `Intent: "${intent.query}" ×${intent.quantity} → ship to "${intent.recipient}" (${shipping.city}, ${shipping.state})`,
      });
      this.say(`Got it. Looking for ${intent.query}, shipping to the ${intent.recipient}.`);

      // 2. Discover the merchant on the x402 Bazaar.
      this.send({ type: 'stage', name: 'discovery', detail: this.cfg.bazaarUrl });
      const disc = await discoverMerchant(this.cfg, intent.query);
      this.send({ type: 'thought', text: `Bazaar: ${disc.note}` });
      if (disc.found) {
        this.say(
          `I searched the x402 Bazaar and found ${disc.serviceName ?? 'BuyWith402'}` +
            `${disc.rank ? `, ranked number ${disc.rank}` : ''}. It sells real hardware for USDC.`,
        );
      } else {
        this.say('Bazaar lookup came up empty, so I am going straight to the merchant I know.');
      }

      // 3. Browse the catalog.
      this.send({ type: 'stage', name: 'browsing', detail: `${this.cfg.merchantUrl}/products` });
      const products = await this.merchant.products();
      this.send({ type: 'products', items: products }); // the UI prints the count

      // 4. Choose.
      this.send({ type: 'stage', name: 'choosing' });
      const choice = await this.brain.chooseProduct(intent, products);
      const product = products.find((p) => p.id === choice.product_id);
      if (!product) throw new Error(`chosen product ${choice.product_id} not in catalog`);

      // 5. Spend guard decides dry-run vs real.
      const price = parseFloat(product.price_usd.replace(/[^0-9.]/g, ''));
      let dryRun = this.cfg.demoDryRun;
      let guardNote: string | undefined;
      if (!dryRun) {
        if (!this.cfg.allowRealPurchase) {
          dryRun = true;
          guardNote = 'ALLOW_REAL_PURCHASE is not set — forcing dry run.';
        } else if (!(price <= this.cfg.maxSpendUsd)) {
          dryRun = true;
          guardNote = `Price $${price.toFixed(2)} exceeds MAX_SPEND_USD=$${this.cfg.maxSpendUsd} — forcing dry run.`;
        }
      }
      if (guardNote) this.send({ type: 'thought', text: `Spend guard: ${guardNote}` });

      this.pendingPurchase = {
        product,
        quantity: intent.quantity,
        recipient: intent.recipient,
        shipping,
        dryRun,
      };
      this.send({
        type: 'choice',
        product,
        reason: choice.reason,
        quantity: intent.quantity,
        recipient: intent.recipient,
        total_usd: product.price_usd,
      });
      this.say(`I picked ${product.name}. ${choice.reason}`);
      const mode = dryRun ? 'as a dry run rehearsal' : 'for real';
      this.say(
        `That is ${product.price_usd} in USDC all-inclusive, ${mode}. Say yes to confirm, or no to cancel.`,
      );
      this.send({
        type: 'await_confirmation',
        summary: `${product.name} — ${product.price_usd} USDC → ${intent.recipient}${dryRun ? ' (dry run)' : ''}`,
      });
      this.state = 'confirming';
    } catch (e) {
      this.fail('I hit a problem while preparing the order.', e);
    }
  }

  private async resolveConfirmation(confirmed: boolean): Promise<void> {
    if (this.state !== 'confirming' || !this.pendingPurchase) return;
    if (!confirmed) {
      this.say('Okay, cancelled. Nothing was purchased.');
      this.resetToIdle();
      return;
    }
    const { product, quantity, shipping, dryRun } = this.pendingPurchase;
    this.state = 'working';
    try {
      // The 402 challenge itself declares the network; don't guess it here.
      this.send({ type: 'stage', name: 'paying', detail: 'x402 exact scheme / USDC' });
      this.say(
        this.rig.mode === 'real'
          ? 'Paying now: one signed USDC transfer over the x402 protocol.'
          : 'Paying now. Payment is simulated in this mode, but the flow is identical.',
      );
      const order = await this.merchant.purchase(product.id, {
        quantity,
        shipping,
        dry_run: dryRun,
      });
      this.send({ type: 'order', order_id: order.order_id, dry_run: order.dry_run ?? dryRun });
      this.say(
        `Payment settled. Order ${order.order_id.slice(0, 8)} is queued, and a browser agent is heading to the merchant site to check out.`,
      );
      this.state = 'fulfilling';
      this.pollOrder(order.order_id, product, 0);
    } catch (e) {
      this.fail('The purchase failed.', e);
    }
  }

  // --- Fulfillment narration ---------------------------------------------------

  private narratedLiveView = false;

  private pollOrder(orderId: string, product: Product, since: number): void {
    if (this.closed) return;
    const intervalMs = this.cfg.mockMerchant ? Math.max(300, this.cfg.mockEventMs / 2) : 2500;
    void (async () => {
      let nextSince = since;
      try {
        const status = await this.merchant.order(orderId, since);
        nextSince = status.next_since ?? since + (status.events?.length ?? 0);
        for (const event of status.events ?? []) {
          this.send({ type: 'fulfillment_event', event });
          if (this.shouldNarrate(event)) {
            const line = await this.brain.narrateEvent(event, product.name);
            this.say(line);
          }
        }
        this.send({
          type: 'order_status',
          status: status.status,
          final: !!status.final,
          outcome: status.outcome,
        });
        if (status.final) {
          const success = status.outcome !== 'failure';
          this.say(
            success
              ? `All done. Order ${orderId.slice(0, 8)} finished with status ${status.status}. Thanks for shopping by voice.`
              : `I'm sorry — fulfillment failed after retries. Order ${orderId.slice(0, 8)} did not complete.`,
          );
          this.send({ type: 'done', outcome: status.outcome ?? 'success', order_id: orderId });
          this.state = 'done';
          return;
        }
      } catch (e) {
        // Transient poll errors: log, keep polling.
        logError('[session] order poll failed (will retry):', e);
      }
      this.pollTimer = setTimeout(() => this.pollOrder(orderId, product, nextSince), intervalMs);
    })();
  }

  /** Narrate stage changes and screenshots — not every poll or agent step. */
  private shouldNarrate(event: OrderEvent): boolean {
    if (event.stage === 'checkpoint') return true; // screenshots are the star
    if (event.stage === 'live_view' && !this.narratedLiveView) {
      this.narratedLiveView = true;
      return true;
    }
    if (event.stage === 'worker' && /started|finished|complete|error/i.test(event.message)) {
      return true;
    }
    return false; // agent/local chatter stays on-screen only
  }

  // --- Housekeeping --------------------------------------------------------------

  private fail(spoken: string, err: unknown): void {
    const msg = logError('[session] pipeline error:', err);
    this.send({ type: 'error', message: msg });
    this.say(`${spoken} ${msg.length < 120 ? msg : 'Check the console for details.'}`);
    this.resetToIdle();
  }

  private resetToIdle(): void {
    this.state = 'idle';
    this.pendingPurchase = undefined;
    this.narratedLiveView = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }
}
