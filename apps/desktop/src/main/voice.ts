import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
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
import { app } from 'electron';

/**
 * The bundled ffmpeg, if this edition ships one. Same search the Pro video
 * suite uses (extraResources, then the workspace install, then FFMPEG_BIN) —
 * inlined here because the video module itself is not part of this edition,
 * and transcoding a phone clip must not drag it in.
 */
const FFMPEG_EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
let ffmpegCached: string | null | undefined;
function resolveFfmpegPath(): string | null {
  if (ffmpegCached !== undefined) return ffmpegCached;
  const appPath = app.getAppPath();
  const override = process.env.FFMPEG_BIN;
  const candidates = [
    ...(override ? [override] : []),
    join(process.resourcesPath ?? '', 'ffmpeg', FFMPEG_EXE),
    join(appPath, 'node_modules', 'ffmpeg-static', FFMPEG_EXE),
    join(appPath, '..', '..', 'node_modules', 'ffmpeg-static', FFMPEG_EXE),
  ];
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return (ffmpegCached = c);
    } catch {
      /* keep looking */
    }
  }
  return (ffmpegCached = null);
}

const pExecFile = promisify(execFile);

/**
 * Re-cut a clip as the 16 kHz mono WAV whisper.cpp insists on.
 *
 * Only ever called when the engine is the local one and the clip is not
 * already a WAV. That happens for exactly one reason today: Android's recorder
 * has no raw-PCM mode, so the companion app can only hand over AAC in an MP4
 * box. The cloud endpoint takes that happily; whisper.cpp reads WAV and
 * nothing else, so without this a phone would work for one kind of user and
 * fail for the other, with an error about containers that nobody asked to
 * care about.
 */
async function toWhisperWav(data: Uint8Array, ext: string): Promise<Uint8Array> {
  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg) throw new Error('whisper-local needs WAV, and the bundled ffmpeg was not found.');
  const dir = await mkdtemp(join(tmpdir(), 'vo-stt-'));
  const src = join(dir, `in.${ext || 'm4a'}`);
  const out = join(dir, 'out.wav');
  try {
    await writeFile(src, data);
    // -ar 16000 -ac 1: the rate and channel count whisper.cpp wants; anything
    // else it resamples internally at best and refuses at worst.
    await pExecFile(ffmpeg, ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-f', 'wav', out]);
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

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

  /**
   * A clip that did not come from the mic — an attached file, or a voice note
   * off Telegram. Same engine and same language setting; only the container
   * differs, and the engine is told what it is.
   */
  async transcribeFile(data: Uint8Array, mimeType: string, fileName: string): Promise<string> {
    const isWav = /wav|wave|pcm/.test(mimeType.toLowerCase());
    if (this.config.get().voice.stt === 'whisper-local' && !isWav) {
      const wav = await toWhisperWav(data, fileName.split('.').pop()?.toLowerCase() ?? 'm4a');
      return this.transcribe(wav, { mimeType: 'audio/wav', fileName: 'audio.wav' });
    }
    return this.transcribe(data, { mimeType, fileName });
  }

  transcribe(wav: Uint8Array, media?: { mimeType: string; fileName: string }): Promise<string> {
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
    return this.stt().transcribe(wav, { ...opts, ...(media ?? {}) });
  }

  /** The configured engine, built fresh so a settings change applies at once. */
  private ttsProvider(): TtsProvider {
    const v = this.config.get().voice;
    switch (v.tts) {
      case 'openai': {
        const apiKey = this.secrets.get('openai');
        if (!apiKey) throw new Error('OpenAI TTS needs your OpenAI key (Settings → API keys).');
        return new OpenAiTts({ apiKey, voice: v.openaiVoice, speed: v.ttsSpeed });
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
        return new OpenAiTts({
          apiKey,
          baseURL: cleanIdentifier(v.compatBaseUrl),
          speed: v.ttsSpeed,
          ...(model ? { model } : {}),
          ...(compatVoice ? { voice: compatVoice } : {}),
        });
      }
      case 'elevenlabs': {
        const apiKey = this.secrets.get('elevenlabs');
        if (!apiKey) throw new Error('ElevenLabs needs its API key (Settings → Voice).');
        if (!v.elevenVoiceId) {
          throw new Error('ElevenLabs needs a voice id (Settings → Voice).');
        }
        return new ElevenLabsTts({
          apiKey,
          voiceId: v.elevenVoiceId,
          ...(v.elevenModel ? { model: v.elevenModel } : {}),
        });
      }
      default:
        return new SystemTts({
          ...(v.systemVoice ? { voice: v.systemVoice } : {}),
          rate: v.systemRate,
          pitch: v.systemPitch,
        });
    }
  }

  async speak(text: string): Promise<TtsOutput> {
    const v = this.config.get().voice;
    if (v.tts === 'none') return { kind: 'native' };
    // Markdown reads terribly aloud — every engine gets speakable text only.
    const clean = speakable(text);
    if (!clean) return { kind: 'native' };
    this.stopSpeak();
    this.activeTts = this.ttsProvider();
    return this.activeTts.speak(clean);
  }

  /**
   * Speech as BYTES, for sending somewhere rather than playing here — a voice
   * reply on Telegram. Deliberately outside the active-playback bookkeeping:
   * answering the phone must not cut off what the app is saying in the room.
   * The system voice speaks out of the local speakers and produces no file, so
   * it cannot serve this.
   */
  async synthesize(text: string): Promise<{ data: Uint8Array; mimeType: string } | null> {
    const v = this.config.get().voice;
    if (v.tts === 'none' || v.tts === 'system') return null;
    const clean = speakable(text);
    if (!clean) return null;
    const out = await this.ttsProvider().speak(clean);
    return out.kind === 'audio' ? { data: out.data, mimeType: out.mimeType } : null;
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
