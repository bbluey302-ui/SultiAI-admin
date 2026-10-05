// The Sulti character roster.
//
// Kept in sync by hand with `_shared/prompts.ts` in the Edge Functions (which
// is the source of truth for prompts) and with the `voices` task on the `ai`
// Edge Function. Duplicated on the client deliberately: the settings picker has
// to render instantly on mount, and a network round-trip to list six
// characters would be both slower and a hard dependency for the voice UI.
//
// The one thing that changed from the original server-side table is that
// `locale` replaces `voiceName`. `voiceName` named a Microsoft Edge neural TTS
// voice because synthesis used to happen on the server; Edge's endpoint now
// rejects cloud IPs with a 403, so synthesis is on-device via `expo-speech`,
// which picks a voice by BCP-47 locale instead of by name.

export const CHARACTER_VOICES = {
  blessica: {
    label: 'Blessica',
    name: 'Blessica (Female, Professional)',
    description: 'Professional, articulate female voice - the default Sulti instructor',
    locale: 'fil-PH',
    rate: 1.0,
    pitch: 1.05,
    accent: 'Filipino (Tagalog), female',
  },
  angel: {
    label: 'Angel',
    name: 'Angel (Male, Clear)',
    description: 'Clear, professional male voice with precise articulation',
    locale: 'fil-PH',
    rate: 0.95,
    pitch: 1.0,
    accent: 'Filipino (Tagalog), male',
  },
  sultan: {
    label: 'Sultan',
    name: 'Sultan (Male, Scholarly)',
    description: 'Scholarly male voice with academic authority and cultural expertise',
    locale: 'en-PH',
    rate: 0.9,
    pitch: 0.95,
    accent: 'English with Filipino accent, male',
  },
  lola: {
    label: 'Lola',
    name: 'Lola (Elder Female, Wise)',
    description: 'Wise, experienced female voice with deep cultural knowledge',
    locale: 'en-PH',
    rate: 0.82,
    pitch: 0.92,
    accent: 'English with Filipino accent, female (slower, softer)',
  },
  bryan: {
    label: 'Bryan',
    name: 'Bryan (Male, Professional)',
    description: 'Professional male voice for clear English instruction',
    locale: 'en-US',
    rate: 1.0,
    pitch: 1.0,
    accent: 'American English, male',
  },
  jenny: {
    label: 'Jenny',
    name: 'Jenny (Female, Articulate)',
    description: 'Articulate female voice for professional English content',
    locale: 'en-US',
    rate: 1.0,
    pitch: 1.1,
    accent: 'American English, female',
  },
};

export const DEFAULT_CHARACTER = 'blessica';

/** Resolve a client-supplied character id to a known key, else the default. */
export function resolveCharacterKey(id) {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(CHARACTER_VOICES, key) ? key : DEFAULT_CHARACTER;
}

/** BCP-47 locale `expo-speech` should use for a given character key. */
export function characterLocale(id) {
  return CHARACTER_VOICES[resolveCharacterKey(id)].locale;
}

/** Shape returned by `api.getVoices()` — matches the old `GET /api/speech/voices`. */
export function voiceList() {
  return Object.entries(CHARACTER_VOICES).map(([key, v]) => ({ id: key, ...v }));
}
