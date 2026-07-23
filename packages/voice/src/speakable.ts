/**
 * Assistant replies are markdown; TTS engines read them literally — "asterisk
 * asterisk Fresh beans asterisk asterisk" — so everything spoken goes through
 * this first: markup stripped, tables and code turned into speech-sized
 * mentions, symbols translated.
 */
export function speakable(text: string): string {
  let t = text;
  // Code: never read source aloud.
  t = t.replace(/```[\s\S]*?```/g, '. Code block omitted. ');
  t = t.replace(/`([^`\n]*)`/g, '$1');
  // Images / links → their visible text.
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Bare URLs are noise when spoken.
  t = t.replace(/https?:\/\/\S+/g, ' a link ');
  // HTML remnants (<br> shows up in model tables constantly).
  t = t.replace(/<br\s*\/?>/gi, '. ');
  t = t.replace(/<[^>\n]+>/g, ' ');
  // Headers, emphasis, strikethrough markers.
  t = t.replace(/^#{1,6}\s*/gm, '');
  t = t.replace(/[*_~]{1,3}/g, '');
  // Tables: separator rows vanish, pipes become pauses.
  t = t.replace(/^\s*[|:\s+-]{4,}\s*$/gm, ' ');
  t = t.replace(/\s*\|\s*/g, ', ');
  // Bullets and blockquotes.
  t = t.replace(/^\s*[-*•+]\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  // Symbols that read badly.
  t = t.replace(/[→⇒➜]/g, ' to ');
  t = t.replace(/≈/g, ' about ');
  t = t.replace(/[#|]/g, ' ');
  // Collapse the debris.
  t = t.replace(/\s*\n\s*/g, '. ');
  t = t.replace(/\s{2,}/g, ' ');
  t = t.replace(/(?:\s*[.,]\s*){2,}([.,])/g, '$1 ');
  t = t.replace(/\s+([.,!?])/g, '$1');
  return t.trim();
}
