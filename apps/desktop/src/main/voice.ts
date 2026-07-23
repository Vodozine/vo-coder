import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  ElevenLabsTts,
  OpenAiStt,
  OpenAiTts,
  speakable,
  SystemTts,
  WhisperLocalStt,
  type SttProvider,
  type TtsOutput,
  type TtsProvider,
} from '@vo-coder/voice';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';

/** Builds STT/TTS from current settings on each call so config changes apply
 *  immediately; keys come from the same encrypted secret store as chat. */
export class VoiceHost {
  private activeTts: TtsProvider | null = null;

  constructor(
    private config: ConfigStore,
    private secrets: SecretStore,
  ) {}

  /**
   * whisper.cpp's `main(.exe)` became a deprecation stub that exits with
   * failure — older setups saved that path. Transparently upgrade to the real
   * whisper-cli sitting next to it, and persist the fix.
   */
  private healWhisperPath(path: string): string {
    const base = basename(path).toLowerCase();
    if (base !== 'main.exe' && base !== 'main') return path;
    const cli = join(dirname(path), base === 'main.exe' ? 'whisper-cli.exe' : 'whisper-cli');
    if (!existsSync(cli)) return path;
    const v = this.config.get().voice;
    this.config.set({ voice: { ...v, whisperPath: cli } });
    return cli;
  }

  private stt(): SttProvider {
    const v = this.config.get().voice;
    if (v.stt === 'whisper-local') {
      if (!v.whisperPath || !v.whisperModel) {
        throw new Error(
          'whisper-local needs the binary path and model path — set both in Settings → Voice.',
        );
      }
      return new WhisperLocalStt({
        binaryPath: this.healWhisperPath(v.whisperPath),
        modelPath: v.whisperModel,
      });
    }
    const apiKey = this.secrets.get('openai');
    if (!apiKey) {
      throw new Error(
        'Voice transcription uses your OpenAI key — add it in Settings, or switch STT to whisper-local.',
      );
    }
    return new OpenAiStt({ apiKey, model: v.sttModel });
  }

  transcribe(wav: Uint8Array): Promise<string> {
    return this.stt().transcribe(wav);
  }

  async speak(text: string): Promise<TtsOutput> {
    const v = this.config.get().voice;
    if (v.tts === 'none') return { kind: 'native' };
    // Markdown reads terribly aloud — every engine gets speakable text only.
    const clean = speakable(text);
    if (!clean) return { kind: 'native' };
    this.stopSpeak();
    switch (v.tts) {
      case 'openai': {
        const apiKey = this.secrets.get('openai');
        if (!apiKey) throw new Error('OpenAI TTS needs your OpenAI key (Settings → API keys).');
        this.activeTts = new OpenAiTts({ apiKey, voice: v.openaiVoice });
        break;
      }
      case 'compat': {
        if (!v.compatBaseUrl) {
          throw new Error('Custom TTS needs its endpoint base URL (Settings → Voice).');
        }
        // Many local endpoints (Kokoro etc.) need no key at all.
        const apiKey = this.secrets.get('tts-custom') ?? 'none';
        this.activeTts = new OpenAiTts({
          apiKey,
          baseURL: v.compatBaseUrl,
          ...(v.compatModel ? { model: v.compatModel } : {}),
          ...(v.compatVoice ? { voice: v.compatVoice } : {}),
        });
        break;
      }
      case 'elevenlabs': {
        const apiKey = this.secrets.get('elevenlabs');
        if (!apiKey) throw new Error('ElevenLabs needs its API key (Settings → Voice).');
        if (!v.elevenVoiceId) {
          throw new Error('ElevenLabs needs a voice id (Settings → Voice).');
        }
        this.activeTts = new ElevenLabsTts({
          apiKey,
          voiceId: v.elevenVoiceId,
          ...(v.elevenModel ? { model: v.elevenModel } : {}),
        });
        break;
      }
      default:
        this.activeTts = new SystemTts({
          ...(v.systemVoice ? { voice: v.systemVoice } : {}),
          rate: v.systemRate,
        });
    }
    return this.activeTts.speak(clean);
  }

  stopSpeak(): void {
    this.activeTts?.stop();
    this.activeTts = null;
  }
}
