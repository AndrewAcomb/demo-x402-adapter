/**
 * Gradium voice: TTS over HTTPS POST, STT over WebSocket.
 * Protocol per docs.gradium.ai (verified 2026-07-12):
 *  - TTS: POST /api/post/speech/tts {text, voice_id, output_format, only_audio} -> raw WAV bytes
 *  - STT: wss /api/speech/asr; JSON setup, then {"type":"audio","audio":"<b64 pcm>"} chunks
 *    at 24 kHz mono PCM16; server sends ready / text / end_text / end_of_stream / error.
 */

import WebSocket from 'ws';
import type { Config } from './config.js';
import { logError } from './config.js';

const TTS_URL = 'https://api.gradium.ai/api/post/speech/tts';
const ASR_URL = 'wss://api.gradium.ai/api/speech/asr';

/** Synthesize one line. Returns WAV bytes, or null when voice is mocked/unavailable. */
export async function synthesize(cfg: Config, text: string): Promise<Buffer | null> {
  if (cfg.mockVoice || !cfg.gradiumApiKey) return null;
  try {
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.gradiumApiKey },
      body: JSON.stringify({
        text,
        voice_id: cfg.gradiumVoiceId,
        output_format: 'wav',
        only_audio: true,
        model_name: 'default',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    logError('[voice] TTS failed (line will be text-only):', e);
    return null;
  }
}

export interface AsrHandlers {
  /** Accumulated text of the utterance in progress. */
  onPartial: (text: string) => void;
  /** A finished utterance (semantic VAD fired, or the stream ended). */
  onFinal: (text: string) => void;
  onError: (message: string) => void;
}

/**
 * One live microphone session relayed to Gradium ASR.
 * The browser sends 24 kHz mono PCM16 chunks (base64) over our own WS;
 * we forward them verbatim inside Gradium's JSON audio messages.
 */
export class AsrSession {
  private ws?: WebSocket;
  private buffer: string[] = [];
  private closed = false;
  private pending: string[] = []; // audio queued before "ready"
  private ready = false;

  constructor(
    private cfg: Config,
    private handlers: AsrHandlers,
  ) {}

  start(): void {
    if (!this.cfg.gradiumApiKey) {
      this.handlers.onError('GRADIUM_API_KEY missing — live speech unavailable');
      return;
    }
    this.ws = new WebSocket(ASR_URL, {
      headers: { 'x-api-key': this.cfg.gradiumApiKey },
    });
    this.ws.on('open', () => {
      this.ws?.send(
        JSON.stringify({
          type: 'setup',
          model_name: 'default',
          input_format: 'pcm',
          json_config: { language: 'en', delay_in_frames: 16 },
        }),
      );
    });
    this.ws.on('message', (data) => this.onMessage(data.toString()));
    this.ws.on('error', (err) => {
      if (!this.closed) this.handlers.onError(logError('[voice] ASR socket error:', err));
    });
    this.ws.on('close', () => this.flushFinal());
  }

  private onMessage(raw: string): void {
    let msg: { type?: string; text?: string; message?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        for (const chunk of this.pending.splice(0)) this.forward(chunk);
        break;
      case 'text':
        if (msg.text) {
          this.buffer.push(msg.text);
          this.handlers.onPartial(this.joined());
        }
        break;
      case 'end_text':
        this.flushFinal();
        break;
      case 'end_of_stream':
        this.flushFinal();
        this.close();
        break;
      case 'error':
        this.handlers.onError(`ASR error: ${msg.message ?? 'unknown'}`);
        break;
      default:
        break; // 'step' (VAD probabilities) and friends — ignored
    }
  }

  private joined(): string {
    // Gradium emits word/segment pieces; join and normalize spacing.
    return this.buffer.join(' ').replace(/\s+/g, ' ').replace(/\s([,.?!])/g, '$1').trim();
  }

  private flushFinal(): void {
    const text = this.joined();
    this.buffer = [];
    if (text) this.handlers.onFinal(text);
  }

  private forward(audioB64: string): void {
    this.ws?.send(JSON.stringify({ type: 'audio', audio: audioB64 }));
  }

  /** base64-encoded 24 kHz mono PCM16 from the browser. */
  sendAudio(audioB64: string): void {
    if (this.closed) return;
    if (this.ready) this.forward(audioB64);
    else this.pending.push(audioB64);
  }

  /** Mic released: ask for remaining results, then end the stream. */
  stop(): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.flushFinal();
      return;
    }
    try {
      this.ws.send(JSON.stringify({ type: 'flush', flush_id: 1 }));
      this.ws.send(JSON.stringify({ type: 'end_of_stream' }));
    } catch {
      this.flushFinal();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
