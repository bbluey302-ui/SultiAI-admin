// Ported from `server/src/routes/whisper.routes.ts`.
//
// The per-dialect `LANGUAGE_PROMPTS` corpus in the original file is marked
// "kept for reference" and is referenced by no handler, so it is not carried
// over. The active `getTeacherPrompt` auto-detect prompt IS, because
// src/screens/WhisperAIScreen.js regex-parses its fixed output contract.

export const LANGUAGE_META: Record<
  string,
  { name: string; native: string; region: string; code: string }
> = {
  tagalog: { name: 'Tagalog', native: 'Tagalog', region: 'Central/Southern Luzon', code: 'tl' },
  cebuano: {
    name: 'Cebuano (Bisaya)',
    native: 'Bisaya',
    region: 'Visayas & Mindanao',
    code: 'ceb',
  },
  ilocano: { name: 'Ilocano', native: 'Ilokano', region: 'Northern Luzon', code: 'ilo' },
  hiligaynon: { name: 'Hiligaynon', native: 'Ilonggo', region: 'Western Visayas', code: 'hil' },
  bikol: { name: 'Bikol', native: 'Bikolano', region: 'Bicol Peninsula', code: 'bik' },
  waray: { name: 'Waray', native: 'Winaray', region: 'Eastern Visayas', code: 'war' },
  kapampangan: {
    name: 'Kapampangan',
    native: 'Kapampangan',
    region: 'Central Luzon',
    code: 'pam',
  },
  pangasinan: { name: 'Pangasinan', native: 'Pangasinan', region: 'Pangasinan', code: 'pag' },
};

/** Default target when the client omits one — matches the original. */
export const DEFAULT_DIALECT = 'cebuano';

export function resolveDialect(language: unknown): string {
  const key = typeof language === 'string' ? language.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(LANGUAGE_META, key) ? key : DEFAULT_DIALECT;
}

export function languageMeta(language: unknown) {
  return LANGUAGE_META[resolveDialect(language)];
}

/**
 * The prompt forces a rigid output shape, and WhisperAIScreen.js reads it with
 * a regex on line 1. Changing the contract here breaks that screen, so the
 * wording is byte-identical to the original.
 */
export function getTeacherPrompt(target: string): string {
  return `You are "Sulti Whisper", an encouraging Philippine language teacher. You teach ${target} to learners who may speak ANY Philippine language, English, or a mix.

YOUR TASK for every user message (typed or transcribed from voice):
1. AUTO-DETECT the language/dialect the user actually wrote or spoke. Candidates: English, Tagalog, Taglish (Tagalog-English mix), Bisaya/Cebuano, Ilocano, Hiligaynon/Ilonggo, Bikol, Waray, Kapampangan, Pangasinan, or a mix.
2. Gently ACKNOWLEDGE them. If they spoke in another language, CORRECT by giving the natural ${target} version. If they were already correct or partly correct in ${target}, affirm and polish it.
3. TEACH: break down 2-4 key ${target} words/phrases with meanings and usage notes, comparing to the word the learner used (e.g., English/Tagalog word -> ${target} word).
4. ENGAGE: end with a short follow-up question or practice prompt in ${target}.

FORMAT EVERY RESPONSE EXACTLY LIKE THIS (no other preamble; first line is always the detection):
🗣️ Detected: <language or mix detected>
💡 In ${target}: "<natural ${target} translation or response>"
📚 Breakdown:
• <word> = <meaning> (<how to use it>)
• <word> = <meaning> (<how to use it>)
💬 Sulti: <1-2 warm conversational sentences, ending with a simple question in ${target} followed by an English gloss in parentheses>

RULES:
- If the user already wrote in ${target}, replace the translation line with a praise line like "💡 Nice! Nindot kaayo!" and still teach 2-3 words from what they said.
- Correct gently, never criticize. Match the learner's energy.
- Use ${target} words with diacritics where appropriate.
- Keep the whole response concise and scannable.`;
}

/** Pulls the "🗣️ Detected: X" value off line 1. */
export function extractDetectedLanguage(reply: string): string | null {
  const firstLine = (reply.split('\n')[0] || '').replace(/^\s*🗣️?\s*/i, '');
  const m = firstLine.match(/^Detected:\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

export function allLanguages() {
  return Object.entries(LANGUAGE_META).map(([id, meta]) => ({ id, ...meta }));
}
