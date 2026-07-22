import {
  OpenAiStt,
  OpenAiTts,
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

  private stt(): SttProvider {
    const v = this.config.get().voice;
    if (v.stt === 'whisper-local') {
      if (!v.whisperPath || !v.whisperModel) {
        throw new Error(
          'whisper-local needs the binary path and model path — set both in Settings → Voice.',
        );
      }
      return new WhisperLocalStt({ binaryPath: v.whisperPath, modelPath: v.whisperModel });
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
    this.stopSpeak();
    if (v.tts === 'openai') {
      const apiKey = this.secrets.get('openai');
      if (!apiKey) throw new Error('OpenAI TTS needs your OpenAI key (Settings → API keys).');
      this.activeTts = new OpenAiTts({ apiKey, voice: v.openaiVoice });
    } else {
      this.activeTts = new SystemTts();
    }
    return this.activeTts.speak(text);
  }

  stopSpeak(): void {
    this.activeTts?.stop();
    this.activeTts = null;
  }
}
