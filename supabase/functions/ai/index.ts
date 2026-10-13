// SultiAI AI Edge Function.
//
// Replaces the AI surface of the Express server in `server/`:
//   POST /api/tutor/chat              -> task: 'tutor_chat'
//   POST /api/tutor/lesson            -> task: 'lesson'
//   POST /api/whisper/chat            -> task: 'dialect_chat'
//   POST /api/whisper/voice           -> task: 'dialect_voice'
//   POST /api/whisper/phrases         -> task: 'dialect_phrases'
//   GET  /api/whisper/languages       -> task: 'dialect_languages'
//   POST /api/speech/translate        -> task: 'translate'
//   POST /api/speech/detect           -> task: 'detect'
//   POST /api/speech/nlp/analyze      -> task: 'analyze'
//   POST /api/speech/recommend        -> task: 'recommend'
//   POST /api/speech/pronunciation/check -> task: 'pronunciation_check'
//   POST /api/ar/analyze              -> task: 'ar_analyze'
//   GET  /api/roberta/status          -> task: 'capabilities'
//   POST /api/roberta/vocabulary      -> task: 'vocab_exercise'
//   POST /api/roberta/sentence        -> task: 'sentence_complete'
//   POST /api/voice/chat              -> task: 'tutor_chat' + mode: 'voice'
//   GET  /api/voice/status            -> task: 'voice_status'
//   GET  /api/speech/voices           -> task: 'voices'
//
// Data endpoints (conversations, saved phrases, learning progress, XP,
// notifications, ...) are NOT here — the app reads and writes those directly
// through the Supabase client under RLS.
//
// TTS is not here either: Edge TTS now rejects cloud IPs, and OpenRouter's
// Flux TTS model has been delisted, so synthesis happens on-device via
// expo-speech. This function therefore returns text only.
//
// Requires: GROQ_API_KEY (a Supabase secret, never in the APK).

import { withSupabase } from 'npm:@supabase/server@1.9.1';
import {
  groqChat,
  groqJson,
  groqVision,
  groqTranscribeAudio,
  isGroqConfigured,
  parseLooseJson,
  sniffAudioMime,
} from '../_shared/groq.ts';
import { buildSultiPrompt, CHARACTER_VOICES, resolveCharacterKey } from '../_shared/prompts.ts';
import { loadProfile, levelHint } from '../_shared/profile.ts';
import {
  allLanguages,
  extractDetectedLanguage,
  getTeacherPrompt,
  languageMeta,
  resolveDialect,
} from '../_shared/dialects.ts';

type Json = Record<string, unknown>;

function ok(data: unknown) {
  return Response.json({ success: true, data });
}

function fail(message: string, status = 500) {
  return Response.json({ success: false, error: { message } }, { status });
}

async function readBody(req: Request): Promise<Json> {
  try {
    return (await req.json()) as Json;
  } catch {
    return {};
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

// ---------------------------------------------------------------------------
// Tutor chat (in-band analysis protocol)
// ---------------------------------------------------------------------------

interface AiAnalysis {
  detectedMistakes: string[];
  topics: string[];
  userLevel: string;
  intent?: string;
  emotion?: string;
}

const EMPTY_ANALYSIS: AiAnalysis = { detectedMistakes: [], topics: [], userLevel: 'beginner' };

function extractAnalysis(reply: string): AiAnalysis {
  const match = reply.match(/__ANALYSIS__(\{.*?\})__END__/);
  if (!match) return EMPTY_ANALYSIS;
  try {
    const parsed = parseLooseJson<Json>(match[1]);
    return {
      detectedMistakes: (parsed.detected_mistakes as string[]) || [],
      topics: (parsed.topics as string[]) || [],
      userLevel: (parsed.user_level as string) || 'beginner',
      intent: parsed.intent as string | undefined,
      emotion: parsed.emotion as string | undefined,
    };
  } catch {
    return EMPTY_ANALYSIS;
  }
}

function stripAnalysisTag(reply: string): string {
  return reply.replace(/__ANALYSIS__\{.*?\}__END__/, '').trim();
}

const ANALYSIS_DIRECTIVE = `

After your reply, append a single line of machine-readable analysis in exactly this format, on its own:
__ANALYSIS__{"detected_mistakes":["..."],"topics":["..."],"user_level":"beginner|intermediate|advanced","intent":"...","emotion":"..."}__END__
Keep it to at most 3 mistakes and 3 topics. Always emit the block, even when the arrays are empty.`;

// ---------------------------------------------------------------------------
// Pronunciation
// ---------------------------------------------------------------------------

interface PronunciationResult {
  score: number;
  feedback: string;
  phoneme_breakdown: { expected: string; heard: string; correct: boolean; tip?: string }[];
  /**
   * FeedbackScreen renders four sub-scores as percentages. The Express server
   * computed these with ffmpeg-based acoustic analysis, which the edge runtime
   * cannot do, so they are inferred by the model instead. Every value is
   * clamped to 0-1 (except speaking_rate, in syllables per second) because the
   * UI multiplies by 100.
   */
  metrics: {
    pitch_accuracy: number;
    formant_accuracy: number;
    energy_consistency: number;
    speaking_rate: number;
  };
}

const EMPTY_METRICS = {
  pitch_accuracy: 0,
  formant_accuracy: 0,
  energy_consistency: 0,
  speaking_rate: 0,
};

function clamp01(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

/**
 * Keeps the model's acoustic estimates inside the ranges the UI assumes, and
 * guarantees the `metrics` key exists even when the model omits it - the
 * FeedbackScreen renders `result.metrics.x * 100`, which would otherwise print
 * "NaN%".
 */
function normalizePronunciation(raw: PronunciationResult): PronunciationResult {
  const metrics = raw?.metrics || ({} as PronunciationResult['metrics']);
  const rate = Number(metrics.speaking_rate);
  return {
    score: Math.max(0, Math.min(100, Number(raw?.score) || 0)),
    feedback: raw?.feedback || '',
    phoneme_breakdown: Array.isArray(raw?.phoneme_breakdown) ? raw.phoneme_breakdown : [],
    metrics: {
      pitch_accuracy: clamp01(metrics.pitch_accuracy),
      formant_accuracy: clamp01(metrics.formant_accuracy),
      energy_consistency: clamp01(metrics.energy_consistency),
      speaking_rate: Number.isFinite(rate) && rate > 0 ? rate : 0,
    },
  };
}

async function assessPronunciation(text: string): Promise<PronunciationResult | undefined> {
  try {
    const raw = await groqJson<PronunciationResult>(
      `You are a Bisaya pronunciation coach. Analyze the given text.
Return ONLY a valid JSON object with:
- "score" (0-100)
- "feedback" (one short encouraging sentence)
- "phoneme_breakdown" (array of up to 6 {expected, heard, correct, tip})
- "metrics" (object with "pitch_accuracy", "formant_accuracy" and "energy_consistency" each a number between 0 and 1, and "speaking_rate" in syllables per second, typically 3-6)`,
      `Analyze pronunciation for this Bisaya text: "${text}"`,
      { temperature: 0.3, maxTokens: 700 }
    );
    return normalizePronunciation(raw);
  } catch {
    // The Express pipeline also swallowed this failure and omitted the field.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Task handlers
// ---------------------------------------------------------------------------

type Ctx = { supabase: any };

async function handleTutorChat(body: Json, ctx: Ctx) {
  const message = str(body.message);
  const audio = str(body.audio);
  const sessionId = str(body.session_id);

  if (!message && !audio) return fail('Provide either a message or audio.', 400);

  // `/api/voice/chat` is the same pipeline as `/api/tutor/chat` — it only ever
  // differed in that it forced the voice-mode prompt (short, spoken replies)
  // even when the learner typed instead of spoke. The client sends `mode` to
  // reproduce that, so both screens share one code path.
  const mode: 'chat' | 'voice' = str(body.mode) === 'voice' || (!str(body.mode) && !!audio) ? 'voice' : 'chat';
  const character = resolveCharacterKey(body.character ?? body.voice);

  const profile = await loadProfile(ctx.supabase);

  let text = message;
  let transcription: string | undefined;

  if (audio) {
    const { filename, mimeType } = sniffAudioMime(audio);
    text = await groqTranscribeAudio(audio, filename, mimeType);
    transcription = text;
    if (!text) return fail('Could not transcribe the audio. Please try again.', 422);
  }

  // Session history comes from the DB directly now. RLS on conversation_messages
  // scopes this to the caller's own conversations.
  const history = await loadRecentHistory(ctx.supabase, sessionId);

  const systemPrompt = buildSultiPrompt(mode, levelHint(profile)) + ANALYSIS_DIRECTIVE;

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...history,
    { role: 'user' as const, content: text },
  ];

  // CHANGE: voice mode used temperature 0.9 / 512 tokens in the Express server
  // while chat used 0.8 / 1000. Voice replies must stay short enough to be
  // spoken, so the tighter budget is kept for that mode only.
  const raw = await groqChat(messages, {
    temperature: mode === 'voice' ? 0.9 : 0.8,
    maxTokens: mode === 'voice' ? 512 : 1000,
    reasoningEffort: 'low',
  });
  const analysis = extractAnalysis(raw);
  const reply = stripAnalysisTag(raw);

  const pronunciation = audio && transcription ? await assessPronunciation(transcription) : undefined;

  await recordTurn(ctx.supabase, sessionId, text, reply, analysis);

  return ok({
    reply,
    session_id: sessionId || null,
    transcription: transcription ?? null,
    pronunciation: pronunciation ?? null,
    analysis,
    character,
    mode,
    // TTS is on-device (expo-speech). These two fields keep the old
    // `/api/voice/chat` response shape so existing call sites need no change.
    tts_url: null,
    tts_failed: false,
    recommendations: analysis.topics.slice(0, 3),
  });
}

async function loadRecentHistory(
  supabase: any,
  sessionId: string
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  if (!sessionId) return [];
  const conversationId = Number(sessionId);
  if (!Number.isFinite(conversationId)) return [];

  try {
    const { data, error } = await supabase
      .from('conversation_messages')
      .select('sender,message')
      .eq('conversation_id', conversationId)
      .order('message_id', { ascending: false })
      .limit(12);

    if (error || !data?.length) return [];

    return data
      .slice()
      .reverse()
      .map((m: Json) => ({
        role: (str(m.sender) === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: str(m.message),
      }))
      .filter((m) => m.content.length > 0);
  } catch {
    return [];
  }
}

/**
 * Persists the turn and credits XP, replacing tutor.controller.ts's
 * `upsertProfileFromAnalysis` plus its message append.
 *
 * Runs best-effort: a DB hiccup must not lose the learner's reply, so every
 * failure here is swallowed after the reply has already been generated.
 *
 * Note the deliberate absence of any `tutor_sessions` write. The Express
 * version never wrote one from `/api/tutor/chat` either — that table was only
 * populated by the old session CRUD endpoints, which are gone.
 * `tutor_sessions` also has no unique constraint on `user_id`, so an upsert
 * there would have failed at runtime regardless.
 */
async function recordTurn(
  supabase: any,
  sessionId: string,
  userText: string,
  reply: string,
  analysis: AiAnalysis
) {
  const conversationId = Number(sessionId);
  const hasConversation = Number.isFinite(conversationId);

  try {
    if (hasConversation) {
      const { error } = await supabase.from('conversation_messages').insert([
        { conversation_id: conversationId, sender: 'user', message: userText },
        { conversation_id: conversationId, sender: 'assistant', message: reply },
      ]);
      if (error) throw error;
    }

    // RLS scopes both the select and the update to the caller's own row, so no
    // user_id filter is needed on the select (the client never learns its PK).
    const { data: profile } = await supabase
      .from('learner_profiles')
      .select('user_id,level,strengths,weak_areas,common_mistakes,total_xp,total_sessions')
      .maybeSingle();
    if (!profile) return;

    const mistakes = analysis.detectedMistakes.slice(0, 3);
    const topics = analysis.topics.slice(0, 3);

    // The original split topics by outcome: an advanced learner (or a turn
    // with no detected mistakes) counts as a strength, otherwise a weak area.
    const treatAsStrength = analysis.userLevel === 'advanced' || mistakes.length === 0;

    const patch: Json = {
      level: analysis.userLevel || profile.level,
      total_xp: Number(profile.total_xp ?? 0) + 10,
      last_active: new Date().toISOString(),
    };

    // `total_sessions` only advanced on ad-hoc turns in the original.
    if (!hasConversation) {
      patch.total_sessions = Number(profile.total_sessions ?? 0) + 1;
    }

    if (mistakes.length) {
      patch.common_mistakes = mergeCsv(profile.common_mistakes, mistakes, 10);
    }
    if (topics.length) {
      if (treatAsStrength) {
        patch.strengths = mergeCsv(profile.strengths, topics, 10);
      } else {
        patch.weak_areas = mergeCsv(profile.weak_areas, topics, 10);
      }
    }

    await supabase.from('learner_profiles').update(patch).eq('user_id', profile.user_id);

    // Per-day XP is what the weekly activity chart reads. tutor_sessions is no
    // longer written, so daily_activity is the only record of "how much did I
    // earn today", and this turn is one of the two things that earns XP.
    await recordDailyXp(supabase, profile.user_id, 10);
  } catch {
    // Best-effort only.
  }
}

/**
 * Adds XP to today's `daily_activity` row, creating it on the first XP of the
 * day. Relies on the unique (user_id, activity_date) index from
 * 20261001_gamification_integrity.sql - without it, concurrent tutor turns
 * would each insert a competing row and split the day's total.
 */
async function recordDailyXp(supabase: any, userId: number, amount: number): Promise<void> {
  const activityDate = new Date().toISOString().slice(0, 10);

  const { data: existing } = await supabase
    .from('daily_activity')
    .select('activity_id,xp_earned')
    .eq('user_id', userId)
    .eq('activity_date', activityDate)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('daily_activity')
      .update({ xp_earned: Number(existing.xp_earned ?? 0) + amount })
      .eq('activity_id', existing.activity_id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from('daily_activity')
    .insert({ user_id: userId, activity_date: activityDate, xp_earned: amount });
  if (error) throw error;
}

/**
 * Comma-joined TEXT column helper: de-duplicate while preserving order, then
 * cap the length. The original kept the last 10 strengths/weak areas and the
 * first 10 mistakes; this keeps the most recent 10 for all three, which is the
 * more useful behaviour and costs nothing.
 */
function mergeCsv(existing: unknown, incoming: string[], limit: number): string {
  const merged: string[] = [];
  for (const value of [...splitCsv(existing), ...incoming]) {
    if (!merged.includes(value)) merged.push(value);
  }
  return merged.slice(-limit).join(',');
}

function splitCsv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim());
  return [];
}

async function handleLesson(body: Json, ctx: Ctx) {
  const situation = str(body.situation).trim();
  if (situation.length < 3) return fail('A situation of at least 3 characters is required.', 400);

  const profile = await loadProfile(ctx.supabase);
  const levelHintText = `The learner is at ${profile.level} level.`;

  const systemPrompt = `You are a Bisaya (Cebuano) language lesson creator. Create a short interactive lesson for the given situation. ${levelHintText}
Return ONLY a valid JSON object (no other text) with this structure:
{
  "situation": "string",
  "text": "short intro paragraph",
  "phrases": [{ "bisaya": "...", "english": "...", "pronunciation": "..." }],
  "dialogue": [{ "speaker": "...", "bisaya": "...", "english": "..." }],
  "cultural_note": "relevant cultural context",
  "practice_suggestions": ["tip 1", "tip 2"]
}`;

  const lesson = await groqJson<Json>(systemPrompt, `Create a lesson for: ${situation}`, {
    temperature: 0.7,
    maxTokens: 1200,
  });

  return ok({ role: 'lesson', ...lesson });
}

async function handleDialectChat(body: Json, _ctx: Ctx) {
  const dialect = resolveDialect(body.language);
  const meta = languageMeta(dialect);
  const message = str(body.message).trim();
  if (!message) return fail('A message is required.', 400);

  const reply = await groqChat(
    [
      { role: 'system', content: getTeacherPrompt(meta.native) },
      { role: 'user', content: message },
    ],
    { temperature: 0.8, maxTokens: 900 }
  );

  return ok({ reply, detected: extractDetectedLanguage(reply), language: meta });
}

async function handleDialectVoice(body: Json, _ctx: Ctx) {
  const dialect = resolveDialect(body.language);
  const meta = languageMeta(dialect);
  const audio = str(body.audio);
  if (!audio) return fail('Audio is required.', 400);

  const { filename, mimeType } = sniffAudioMime(audio);
  const transcription = await groqTranscribeAudio(audio, filename, mimeType);
  if (!transcription) return fail('Could not transcribe the audio.', 422);

  const reply = await groqChat(
    [
      { role: 'system', content: getTeacherPrompt(meta.native) },
      { role: 'user', content: transcription },
    ],
    { temperature: 0.8, maxTokens: 900 }
  );

  return ok({ transcription, reply, detected: extractDetectedLanguage(reply), language: meta });
}

async function handleDialectPhrases(body: Json, _ctx: Ctx) {
  const dialect = resolveDialect(body.language);
  const meta = languageMeta(dialect);
  const topic = str(body.topic).trim() || 'everyday conversation';

  const systemPrompt = `You generate practical ${meta.native} phrase lists for language learners.
Return ONLY a valid JSON object: { "phrases": [{ "native": "...", "english": "...", "pronunciation": "..." }] }
Return between 5 and 8 phrases.`;

  let phrases: { native: string; english: string; pronunciation: string }[];
  try {
    const parsed = await groqJson<{ phrases: typeof phrases }>(systemPrompt, `Topic: ${topic}`, {
      temperature: 0.7,
      maxTokens: 600,
    });
    phrases = Array.isArray(parsed.phrases) ? parsed.phrases : [];
  } catch {
    // Mirrors the Express fallback: re-parse, then split on ' - '.
    const raw = await groqChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Topic: ${topic}` },
      ],
      { temperature: 0.7, maxTokens: 600 }
    );
    try {
      phrases = parseLooseJson<{ phrases: typeof phrases }>(raw).phrases ?? [];
    } catch {
      phrases = raw
        .split('\n')
        .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
        .filter(Boolean)
        .map((line) => {
          const [native, english, pronunciation] = line.split(' - ');
          return {
            native: (native ?? '').trim(),
            english: (english ?? '').trim(),
            pronunciation: (pronunciation ?? '').trim(),
          };
        })
        .filter((p) => p.native);
    }
  }

  return ok({ phrases, language: meta });
}

async function handleTranslate(body: Json, _ctx: Ctx) {
  const text = str(body.text).trim();
  const from = str(body.from, 'auto');
  const to = str(body.to, 'Bisaya');
  if (!text) return fail('Text is required.', 400);

  const translated = await groqChat(
    [
      {
        role: 'system',
        content: `You are a professional translator. Translate the given text from ${from} to ${to}. Only return the translation, with no commentary, no quotes and no explanation.`,
      },
      { role: 'user', content: text },
    ],
    { temperature: 0.3, maxTokens: 500 }
  );

  return ok({ translated_text: translated });
}

async function handleDetect(body: Json, _ctx: Ctx) {
  const text = str(body.text).trim();
  if (!text) return fail('Text is required.', 400);

  const systemPrompt = `You detect Philippine languages and dialects.
Return ONLY a valid JSON object: { "language": "display name", "code": "ISO or local code", "isBisaya": boolean, "confidence": 0-100 }
Candidate dialects: English, Tagalog, Taglish, Cebuano/Bisaya, Ilocano, Hiligaynon, Bikol, Waray, Kapampangan, Pangasinan.`;

  try {
    const result = await groqJson<Json>(systemPrompt, text, { temperature: 0.1, maxTokens: 200 });
    return ok(result);
  } catch {
    // Matches the original's hardcoded final fallback.
    return ok({ language: 'unknown', code: 'unknown', isBisaya: false, confidence: 0 });
  }
}

async function handleAnalyze(body: Json, _ctx: Ctx) {
  const text = str(body.text).trim();
  if (!text) return fail('Text is required.', 400);

  const systemPrompt = `You analyze learner input for intent and emotion.
Return ONLY a valid JSON object: { "intent": "...", "emotion": "...", "context": "...", "language_detected": "...", "is_bisaya_related": boolean, "confidence": 0-100 }`;

  try {
    return ok(await groqJson<Json>(systemPrompt, text, { temperature: 0.1, maxTokens: 400 }));
  } catch {
    return ok({
      intent: 'general_query',
      emotion: 'neutral',
      context: 'language learning',
      language_detected: 'unknown',
      is_bisaya_related: false,
      confidence: 0,
    });
  }
}

async function handleRecommend(body: Json, _ctx: Ctx) {
  const situation = str(body.situation).trim();
  const language = str(body.language, 'Bisaya');
  if (!situation) return fail('A situation is required.', 400);

  const systemPrompt = `You recommend practical ${language} phrases for a specific situation.
Return ONLY a valid JSON object: { "phrases": ["phrase 1", "phrase 2", ...] } with 3 to 5 phrases.`;

  let phrases: string[];
  try {
    const parsed = await groqJson<{ phrases: string[] }>(systemPrompt, `Situation: ${situation}`, {
      temperature: 0.7,
      maxTokens: 500,
    });
    phrases = Array.isArray(parsed.phrases) ? parsed.phrases : [];
  } catch {
    const raw = await groqChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Situation: ${situation}` },
      ],
      { temperature: 0.7, maxTokens: 500 }
    );
    phrases = [raw];
  }

  return ok({ phrases });
}

async function handlePronunciationCheck(body: Json, _ctx: Ctx) {
  const expected = str(body.expected_text) || str(body.text);
  const audio = str(body.audio) || str(body.audio_base64) || str(body.audioBase64);

  if (!expected && !audio) return fail('Provide expected_text or audio.', 400);

  if (!audio) {
    // Text-only path: score the target text itself.
    const scored = await assessPronunciation(expected);
    if (!scored) {
      return ok({
        transcription: null,
        score: 85,
        feedback: 'Good pronunciation! Keep practicing the vowel sounds.',
        phoneme_breakdown: [],
        metrics: EMPTY_METRICS,
        note: 'AI assessment unavailable - using default assessment',
      });
    }
    return ok({ transcription: null, ...scored, note: 'assessed from the target text' });
  }

  // Audio path: transcribe first, then score what was actually said. The
  // Express version ran ffmpeg-based acoustic analysis here; that is not
  // available in the edge runtime, so the assessment is LLM-based instead.
  const { filename, mimeType } = sniffAudioMime(audio);
  const transcription = await groqTranscribeAudio(audio, filename, mimeType);

  if (!transcription) {
    return ok({
      transcription: null,
      score: 0,
      feedback: "We couldn't hear any speech. Please try again a little closer to the microphone.",
      phoneme_breakdown: [],
      metrics: EMPTY_METRICS,
      note: 'no speech detected',
    });
  }

  const scored = await assessPronunciation(transcription);
  if (!scored) {
    return ok({
      transcription,
      score: 85,
      feedback: 'Good attempt! Keep practising this phrase.',
      phoneme_breakdown: [],
      metrics: EMPTY_METRICS,
      note: 'AI assessment unavailable - using default assessment',
    });
  }

  return ok({ transcription, ...scored, note: 'assessed from the recording' });
}

async function handleArAnalyze(body: Json, _ctx: Ctx) {
  const image = str(body.image);
  const scenarioId = body.scenario_id ?? str(body.scenario_context);
  if (!image) return fail('An image is required.', 400);

  // The client ships the scenario's own vocabulary so the model answers with
  // catalogue ids. That is what lets `analyzeARImage` return objects with real
  // bisaya/pronunciation instead of free-text labels the overlay cannot render.
  const candidates = Array.isArray(body.candidates)
    ? body.candidates.filter((c): c is string => typeof c === 'string').slice(0, 40)
    : [];

  const mimeType = str(body.mime_type, 'image/jpeg');
  const instruction = candidates.length
    ? `This is a photo taken inside the "${scenarioId}" scenario. Identify which of these objects are visible: ${candidates.join(', ')}.
Return ONLY a JSON array of the matching ids, using exactly the strings given. Return [] if none are visible.`
    : `This is a photo taken inside the "${scenarioId}" scenario. List the objects visible in it.
Return ONLY a JSON array of short English nouns.`;

  // A scan that finds nothing is a much better outcome for this screen than a
  // hard failure. Vision is the one task with no working provider on the
  // project's Groq key (no vision-capable model is reachable), and previously
  // that surfaced as a 502 that broke the AR scene instead of just showing no
  // overlay. Report the reason so the screen can explain itself.
  let raw: string;
  try {
    raw = await groqVision(image, instruction, mimeType);
  } catch (err: any) {
    const message = err?.message || 'Vision request failed';
    console.warn(`[ai] ar_analyze unavailable: ${message}`);
    return ok({
      objects: [],
      scenario_id: scenarioId,
      vision_available: false,
      note: message,
    });
  }

  let objects: string[] = [];
  try {
    const parsed = parseLooseJson<string[] | { objects?: string[] }>(raw);
    objects = Array.isArray(parsed) ? parsed : (parsed.objects ?? []);
  } catch {
    objects = [];
  }

  return ok({ objects, scenario_id: scenarioId, vision_available: true, note: null });
}

// ---------------------------------------------------------------------------
// Vocabulary exercises
//
// These replace a dead `/api/roberta/*` surface: `api.robertaStatus()`,
// `api.robertaVocabularyExercise()` and `api.robertaSentenceCompletion()` were
// called by VocabularyExercise.js and SentenceCompletion.js but were never
// defined in api.js, so both screens threw `TypeError` on mount and showed
// "RoBERTa Not Available" permanently. They depended on a Python RoBERTa
// service that is not part of this architecture at all, so the exercise is now
// generated by the same Groq-backed model as everything else.
//
// The response shapes are kept identical to what those two components read, so
// the screens themselves are unchanged apart from their error copy.
// ---------------------------------------------------------------------------

const VOCAB_LANGUAGE = 'Tagalog';

interface VocabExercise {
  template: string;
  correct_answer: string;
  translations: { answer: string; english: string };
  predictions: { word: string; score: number }[];
}

async function handleVocabExercise(body: Json, _ctx: Ctx) {
  const difficulty = str(body.difficulty, 'beginner');
  const profile = await loadProfile(_ctx.supabase);

  const systemPrompt = `You write ${VOCAB_LANGUAGE} vocabulary fill-in-the-blank exercises for learners.
The learner is at ${profile.level} level and the requested difficulty is "${difficulty}".

Return ONLY a valid JSON object:
{
  "template": "a sentence with exactly one <mask> where the missing word goes",
  "correct_answer": "the missing ${VOCAB_LANGUAGE} word, lowercase",
  "translations": { "answer": "${VOCAB_LANGUAGE} word", "english": "English translation" },
  "predictions": [{ "word": "a plausible but wrong word", "score": 0.0 }]
}
"predictions" must list the 3 most likely WRONG answers the model itself considered, each with a "score" between 0 and 1 (how tempting the wrong answer is). Never include the correct answer in "predictions".`;

  const raw = await groqJson<VocabExercise>(systemPrompt, `Give me one ${difficulty} ${VOCAB_LANGUAGE} exercise.`, {
    temperature: 0.9,
    maxTokens: 400,
  });

  const template = str(raw?.template).replace(/\[MASK\]/gi, '<mask>');
  if (!template.includes('<mask>') || !raw?.correct_answer) {
    return fail('The model did not return a usable exercise. Please try again.', 422);
  }

  const predictions = Array.isArray(raw.predictions)
    ? raw.predictions
        .filter((p) => p?.word && str(p.word).toLowerCase() !== str(raw.correct_answer).toLowerCase())
        .map((p) => ({ word: str(p.word), score: clamp01(p.score) }))
        .slice(0, 3)
    : [];

  return ok({
    exercise: {
      template,
      correct_answer: str(raw.correct_answer),
      translations: {
        answer: str(raw.translations?.answer) || str(raw.correct_answer),
        english: str(raw.translations?.english),
      },
      predictions,
    },
  });
}

async function handleSentenceComplete(body: Json, _ctx: Ctx) {
  const template = str(body.text) || str(body.template);
  if (!template.includes('<mask>')) {
    return fail('The sentence must contain <mask>.', 400);
  }

  const systemPrompt = `You are a ${VOCAB_LANGUAGE} sentence completion engine.
Given a sentence with exactly one <mask>, predict the most likely word for it and rank alternatives.

Return ONLY a valid JSON object:
{
  "completions": [
    {
      "completed_sentence": "the sentence with <mask> replaced by the predicted word",
      "predicted_word": "the predicted ${VOCAB_LANGUAGE} word, lowercase",
      "confidence": 0.0
    }
  ]
}
Return the single best completion first, then up to 3 progressively less likely alternatives. "confidence" is between 0 and 1.`;

  let completions: { completed_sentence: string; predicted_word: string; confidence: number }[] = [];
  try {
    const raw = await groqJson<{ completions?: typeof completions }>(
      systemPrompt,
      template,
      { temperature: 0.7, maxTokens: 400 }
    );
    completions = Array.isArray(raw?.completions) ? raw.completions : [];
  } catch {
    completions = [];
  }

  const normalized = completions
    .filter((c) => c?.predicted_word)
    .map((c) => ({
      completed_sentence: str(c.completed_sentence) || template.replace('<mask>', str(c.predicted_word)),
      predicted_word: str(c.predicted_word),
      confidence: clamp01(c.confidence),
    }));

  if (!normalized.length) return fail('Could not complete that sentence. Please try again.', 422);

  return ok({
    best_completion: normalized[0],
    completions: normalized,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, (body: Json, ctx: Ctx) => Promise<Response>> = {
  tutor_chat: handleTutorChat,
  lesson: handleLesson,
  dialect_chat: handleDialectChat,
  dialect_voice: handleDialectVoice,
  dialect_phrases: handleDialectPhrases,
  dialect_languages: async () => ok({ languages: allLanguages() }),
  translate: handleTranslate,
  detect: handleDetect,
  analyze: handleAnalyze,
  recommend: handleRecommend,
  pronunciation_check: handlePronunciationCheck,
  ar_analyze: handleArAnalyze,
  vocab_exercise: handleVocabExercise,
  sentence_complete: handleSentenceComplete,
  // Replaces the dead `/api/roberta/status`. VocabularyExercise and
  // SentenceCompletion used to gate on it; now the honest question is simply
  // "is an AI provider configured", which is the same thing voice_status asks.
  capabilities: async () => ok({ available: isGroqConfigured(), provider: 'groq' }),
  // Replaces `GET /api/voice/status`. openrouter_tts is hard-coded false: the
  // delisted Flux TTS model means there is no cloud TTS provider left, so
  // synthesis always happens on-device via expo-speech.
  voice_status: async () =>
    ok({
      groq: isGroqConfigured(),
      openrouter_tts: false,
      mode: isGroqConfigured() ? 'full_pipeline' : 'not_configured',
    }),
  // Replaces `GET /api/speech/voices`. The character list plus the BCP-47
  // locale expo-speech needs, so the settings picker can show accents.
  voices: async () => ok({ voices: Object.entries(CHARACTER_VOICES).map(([key, v]) => ({ id: key, ...v })) }),
};

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: { Allow: 'GET,POST,OPTIONS' } });
    }

    const url = new URL(req.url);
    const body = await readBody(req);
    const task = str(body.task) || url.searchParams.get('task') || '';

    const handler = HANDLERS[task];
    if (!handler) {
      return fail(
        `Unknown task "${task}". Supported: ${Object.keys(HANDLERS).join(', ')}`,
        400
      );
    }

    try {
      // withSupabase already verified the JWT; the RLS-scoped client is bound to
      // the caller, which is what every DB touch below relies on.
      return await handler(body, { supabase: ctx.supabase });
    } catch (err: any) {
      const message = err?.message || 'AI request failed';
      // Surface provider outages as 502 so the client can distinguish "AI is
      // down" from "your request was malformed".
      const status = /Groq|Whisper|API error/i.test(message) ? 502 : 500;
      return fail(message, status);
    }
  }),
};
