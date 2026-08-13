/**
 * Playable-file knowledge, shared by main and renderer: one list, so a format
 * the chat will play is a format Preview will play.
 */

export const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
};

export function audioMimeFor(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_MIME[ext] ?? null;
}

export function isAudioPath(path: string): boolean {
  return audioMimeFor(path) !== null;
}
