import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  ElevenLabsTts,
  listSystemVoices,
  OpenAiStt,
  OpenAiTts,
  speakable,
  SystemTts,
  WhisperLocalStt,
  type SttProvider,
  type SystemVoice,
  type TtsOutput,
  type TtsProvider,
} from '@vo-coder/voice';
import type { ConfigStore } from './config';
import type { SecretStore } from './secrets';
import { cleanIdentifier } from './tts-catalog';

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
    // A transcription server of your own (speaches/faster-whisper on a GPU
    // box) needs no key — the same bargain the custom TTS endpoint makes.
    const baseURL = v.sttBaseUrl?.trim().replace(/\/+$/, '');
    const apiKey = this.secrets.get('openai') ?? (baseURL ? 'none' : null);
    if (!apiKey) {
      throw new Error(
        'Voice transcription uses your OpenAI key — add it in Settings, point speech→text at your ' +
          'own transcription server, or switch to whisper-local.',
      );
    }
    return new OpenAiStt({ apiKey, model: v.sttModel, ...(baseURL ? { baseURL } : {}) });
  }

  transcribe(wav: Uint8Array): Promise<string> {
    const v = this.config.get().voice;
    const language = v.sttLanguage?.trim().toLowerCase();
    // Both engines take a language and neither was ever given one. That is NOT
    // the same as auto-detect: whisper-cli's own default is `-l en`, so an
    // Icelandic sentence was being transcribed AS English — which is why it
    // came back as English-shaped nonsense rather than as bad Icelandic. Empty
    // now means what the settings box says it means.
    const opts =
      v.stt === 'whisper-local'
        ? { language: language || 'auto' }
        : // The OpenAI endpoint genuinely auto-detects when the field is absent,
          // and would reject 'auto' as a language code.
          language
          ? { language }
          : undefined;
    return this.stt().transcribe(wav, opts);
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
        this.activeTts = new OpenAiTts({ apiKey, voice: v.openaiVoice, speed: v.ttsSpeed });
        break;
      }
      case 'compat': {
        if (!v.compatBaseUrl) {
          throw new Error('Custom TTS needs its endpoint base URL (Settings → Voice).');
        }
        // Many local endpoints (Kokoro etc.) need no key at all.
        const apiKey = this.secrets.get('tts-custom') ?? 'none';
        // Model ids get copied out of documentation, which means backticks and
        // quotes ride along and the endpoint answers "model does not exist".
        const model = cleanIdentifier(v.compatModel);
        const compatVoice = cleanIdentifier(v.compatVoice);
        this.activeTts = new OpenAiTts({
          apiKey,
          baseURL: cleanIdentifier(v.compatBaseUrl),
          speed: v.ttsSpeed,
          ...(model ? { model } : {}),
          ...(compatVoice ? { voice: compatVoice } : {}),
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
          pitch: v.systemPitch,
        });
    }
    return this.activeTts.speak(clean);
  }

  stopSpeak(): void {
    this.activeTts?.stop();
    this.activeTts = null;
  }

  /** Installed system voices, so Settings can offer them instead of asking
   *  for a name nobody knows by heart. */
  listVoices(): Promise<SystemVoice[]> {
    return listSystemVoices();
  }
}
