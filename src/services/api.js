// The app's single data/AI facade.
//
// This used to be a thin `fetch` wrapper around the Express server in `server/`.
// That server is gone from the production path, so every method here now talks
// to one of two backends:
//
//   * Supabase Edge Functions (`ai`, `agent-token`) for anything that needs an
//     AI provider key. Keys live in Supabase secrets, never in the APK.
//   * PostgREST via `@supabase/supabase-js` for everything else, with Postgres
//     RLS deciding what the caller may read or write.
//
// The public surface (method names, arguments, and returned shapes) is
// unchanged, so no screen needed to be modified to work without the server.
// Where a shape had to differ internally - e.g. camelCase vs snake_case - the
// result object carries both spellings rather than forcing call sites to change.

import { supabase } from '../lib/supabase';
import {
  clampPercent,
  deleteWhere,
  getAuthId,
  getUserId,
  insertRow,
  insertRows,
  invokeAgentToken,
  invokeAi,
  parseList,
  randomId,
  rows,
  table,
  unwrap,
  updateWhere,
  upsert,
  utcDateKey,
  weekStartKey,
} from '../lib/data';
import {
  AR_SCENARIOS,
  DAILY_CHALLENGES,
  WEEKLY_CHALLENGES,
  findARScenario,
  findChallenge,
  matchARObject,
} from '../lib/content';

const AI_TIMEOUT_MS = 30000;
const VOICE_TIMEOUT_MS = 45000;

// ===========================================================================
// Shared helpers
// ===========================================================================

/** The caller's `public.users` row. RLS allows SELECT on exactly this row. */
async function ownUserRow(columns = '*') {
  const authId = await getAuthId();
  const row = unwrap(
    await table('users').select(columns).eq('supabase_id', authId).maybeSingle(),
    'Could not load your profile.'
  );
  if (!row) {
    throw new Error('Your profile is still being created. Please sign out and sign in again.');
  }
  return row;
}

async function learnerProfile() {
  return unwrap(await table('learner_profiles').select('*').maybeSingle());
}

function toBool(value) {
  return value === true || value === 1 || value === '1' || value === 't';
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Pull the learner_profiles row's `user_id` without an extra round trip. */
async function requireProfile() {
  const profile = await learnerProfile();
  if (!profile) throw new Error('Your learner profile is missing. Please sign out and sign in again.');
  return profile;
}

/**
 * Credits XP the way `learner.repo.ts#addXp` did: an idempotency-keyed
 * `xp_logs` row gates the payout, then `learner_profiles` and today's
 * `daily_activity` row are advanced.
 *
 * There is no atomic increment available to the client under RLS, so this is
 * read-modify-write. The idempotency key makes a duplicate call a no-op, which
 * covers the only realistic race (two taps landing before either resolves).
 */
async function awardXp({ xp, coins = 0, source = 'unknown', idempotencyKey = null }) {
  const amount = Math.round(num(xp));
  if (amount <= 0 && coins <= 0) return { credited: false };

  const userId = await getUserId();
  const profile = await requireProfile();

  if (idempotencyKey) {
    const existing = await rows(
      await table('xp_logs')
        .select('id')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .limit(1)
    );
    if (existing.length) return { credited: false, alreadyClaimed: true };
  }

  if (amount > 0) {
    await insertRow('xp_logs', {
      id: randomId('xp'),
      user_id: userId,
      amount,
      source,
      description: source,
      idempotency_key: idempotencyKey,
      timestamp: new Date().toISOString(),
    });
  }

  const patch = { last_active: new Date().toISOString() };
  if (amount > 0) {
    patch.total_xp = num(profile.total_xp) + amount;
    patch.daily_xp = num(profile.daily_xp) + amount;
  }
  if (coins > 0) patch.coins = num(profile.coins) + coins;
  await updateWhere('learner_profiles', patch, (q) => q.eq('user_id', userId));

  return { credited: true };
}

/** Adds to today's `daily_activity` row, creating it on the first XP of the day. */
async function bumpDailyActivity(userId, xp) {
  if (!(xp > 0)) return;
  const activityDate = utcDateKey();
  const existing = await rows(
    await table('daily_activity')
      .select('activity_id, xp_earned')
      .eq('user_id', userId)
      .eq('activity_date', activityDate)
      .maybeSingle()
  );
  const current = existing[0];
  if (current) {
    await updateWhere(
      'daily_activity',
      { xp_earned: num(current.xp_earned) + xp },
      (q) => q.eq('activity_id', current.activity_id)
    );
  } else {
    await insertRow('daily_activity', {
      user_id: userId,
      activity_date: activityDate,
      xp_earned: xp,
    });
  }
}

const POST_TYPE_KEYS = [
  'question',
  'discussion',
  'tip',
  'vocabulary',
  'translation',
  'pronunciation',
  'culture',
];

/**
 * `community_posts` stores the Bisaya/English pair in `phrase`/`translation`
 * and the post classification in `category` - the same columns the old
 * "resources" feature used. `post_feed` already projects them into `type`,
 * `native` and `english`, so `category` is only needed on the fallback path.
 */
function serializePost(row, authorName, categoryOverride) {
  const rawType = categoryOverride ?? row.type ?? row.category;
  const type = POST_TYPE_KEYS.includes(rawType) ? rawType : 'discussion';
  return {
    id: row.id ?? row.post_id,
    user_id: row.user_id,
    type,
    title: row.title,
    content: row.content,
    // `native`/`english` are the mobile aliases for phrase/translation.
    native: row.native ?? row.phrase ?? row.title,
    english: row.english ?? row.translation ?? null,
    phrase: row.phrase ?? null,
    translation: row.translation ?? null,
    author_name: authorName || row.author_name || 'Anonymous',
    author_verified: toBool(row.author_verified),
    is_native: toBool(row.is_native),
    created_at: row.created_at,
    likes: num(row.likes ?? row.likes_count),
    comments: num(row.comments ?? row.comments_count),
  };
}

/** Every screen filters notifications with either `read` or `is_read`. */
function serializeNotification(row) {
  const read = toBool(row.is_read);
  return {
    ...row,
    id: row.notify_id,
    notify_id: row.notify_id,
    body: row.message ?? '',
    time: row.created_at,
    read,
    is_read: read,
    icon: '',
  };
}

function serializeSavedPhrase(row) {
  return {
    ...row,
    // Call sites read `phrase`, `phrase_text`, `word` or `bisaya` depending on
    // which screen they came from; the column is only ever `phrase`.
    phrase_text: row.phrase,
    word: row.phrase,
    bisaya: row.phrase,
  };
}

function serializeProgressRow(module, stored) {
  const percent = clampPercent(stored?.completion_percent);
  return {
    moduleId: module.module_id,
    module_id: module.module_id,
    moduleKey: module.module_key,
    module_key: module.module_key,
    moduleTitle: module.module_title,
    module_title: module.module_title,
    difficulty: module.difficulty,
    sortOrder: num(module.sort_order),
    sort_order: num(module.sort_order),
    completionPercent: percent,
    completion_percent: percent,
    updatedAt: stored?.updated_at ?? null,
    updated_at: stored?.updated_at ?? null,
  };
}

function serializeVocabulary(row) {
  return {
    id: row.id,
    word: row.word,
    translation: row.translation || '',
    pronunciation: row.pronunciation || '',
    category: row.category || 'custom',
    difficulty: num(row.difficulty, 1),
    mastery: num(row.mastery),
    reviewCount: num(row.review_count),
    easeFactor: num(row.ease_factor, 2.5),
    interval: num(row.interval, 1),
    nextReview: row.next_review,
    lastReview: row.last_review,
    isFavorite: toBool(row.is_favorite),
  };
}

/**
 * SM-2 style update for a flashcard review.
 *
 * `quality` is Anki's 0-5 scale: the offline queue sends 4 for "known" and 1
 * for "unknown", and `submitVocabReview` sends a 0-5 score directly.
 */
function applyReview(previous, quality) {
  const q = Math.max(0, Math.min(5, Math.round(num(quality, 0))));
  const prev = previous || {};
  const ease = num(prev.easeFactor, 2.5);
  const reviews = num(prev.reviewCount);
  const passed = q >= 3;

  const nextEase = Math.max(
    1.3,
    ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  );
  const nextInterval = passed ? (reviews === 0 ? 1 : reviews === 1 ? 6 : Math.round(num(prev.interval, 1) * nextEase)) : 1;
  const mastery = Math.max(0, Math.min(100, num(prev.mastery) + (passed ? 18 : -12)));

  const due = new Date();
  due.setDate(due.getDate() + Math.max(1, nextInterval));

  return {
    ease_factor: Number(nextEase.toFixed(4)),
    interval: nextInterval,
    review_count: reviews + 1,
    mastery,
    next_review: utcDateKey(due),
    last_review: utcDateKey(),
  };
}

/** Converts the `whisper_phrases`/server vocabulary row into the client's shape. */
function serializeARObjects(objects) {
  return (objects || []).map((obj, index) => ({
    ...obj,
    id: obj.id || `${obj.bisaya || 'object'}-${index}`,
  }));
}

// ===========================================================================
// API surface
// ===========================================================================

export const api = {
  // =========================================================================
  // Auth - Supabase Auth directly (UserContext is the real caller)
  // =========================================================================

  signUp: async (email, password, name, native_language, target_language) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
          name,
          native_language,
          target_language,
        },
        emailRedirectTo: undefined,
      },
    });
    if (error) throw new Error(error.message);
    return data;
  },

  signIn: async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return data;
  },

  googleSignIn: async (idToken, email, name, avatar) => {
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: idToken,
      ...(email ? { email } : {}),
      ...(name || avatar ? { options: { data: { full_name: name, avatar_url: avatar } } } : {}),
    });
    if (error) throw new Error(error.message);
    return data;
  },

  // =========================================================================
  // Profile
  // =========================================================================

  getProfile: async () => {
    const row = await ownUserRow(
      'user_id, fullname, username, email, country, role, preferred_lang, learning_lang, avatar_id, created_at'
    );
    let avatar = null;
    if (row.avatar_id) {
      const found = await rows(
        await table('avatars').select('avatar_name, avatar_image').eq('avatar_id', row.avatar_id).maybeSingle()
      );
      if (found[0]) avatar = { name: found[0].avatar_name, image: found[0].avatar_image };
    }
    return {
      id: row.user_id,
      name: row.fullname,
      email: row.email,
      native_language: row.preferred_lang || 'English',
      target_language: row.learning_lang || 'Bisaya',
      username: row.username,
      country: row.country,
      role: row.role,
      avatar,
      created_at: row.created_at,
    };
  },

  updateProfile: async (data = {}) => {
    const row = await ownUserRow('user_id, fullname, preferred_lang, learning_lang, country');
    const patch = {};
    if (data.name != null) patch.fullname = data.name;
    if (data.native_language != null) patch.preferred_lang = data.native_language;
    if (data.target_language != null) patch.learning_lang = data.target_language;
    if (data.learning_language != null) patch.learning_lang = data.learning_language;
    if (data.country != null) patch.country = data.country;
    if (data.username != null) patch.username = data.username;
    if (data.avatar_id != null) patch.avatar_id = data.avatar_id;

    if (Object.keys(patch).length) {
      await updateWhere('users', patch, (q) => q.eq('user_id', row.user_id));
    }

    // Keep Auth metadata in step so `handle_auth_user_metadata_update` (and any
    // other client reading `user_metadata`) sees the same values. Onboarding
    // writes the language pair here and the session refreshes from metadata.
    const meta = {};
    if (patch.fullname) meta.full_name = patch.fullname;
    if (patch.preferred_lang) meta.native_language = patch.preferred_lang;
    if (patch.learning_lang) meta.target_language = patch.learning_lang;
    if (patch.country !== undefined) meta.country = patch.country;
    if (Object.keys(meta).length) {
      const { error } = await supabase.auth.updateUser({ data: meta });
      if (error) console.warn('[api] Could not sync auth metadata:', error.message);
    }

    return api.getProfile();
  },

  // =========================================================================
  // Tutor (Edge Function `ai`)
  // =========================================================================

  tutorChat: (message, audio, sessionId) =>
    invokeAi(
      'tutor_chat',
      { message: message ?? '', audio: audio ?? '', session_id: sessionId ?? '' },
      { timeoutMs: AI_TIMEOUT_MS }
    ),

  voiceChat: (message, audio, sessionId, signal = null, voice = 'blessica') =>
    invokeAi(
      'tutor_chat',
      {
        message: message ?? '',
        audio: audio ?? '',
        session_id: sessionId ?? '',
        character: voice,
        mode: 'voice',
      },
      { signal, timeoutMs: VOICE_TIMEOUT_MS }
    ),

  getTutorLevel: async () => {
    const profile = await learnerProfile();
    return {
      level: profile?.level || 'beginner',
      total_sessions: num(profile?.total_sessions),
      total_xp: num(profile?.total_xp),
    };
  },

  getMistakes: async () => {
    const profile = await learnerProfile();
    return parseList(profile?.common_mistakes);
  },

  getFullLearnerProfile: async () => {
    const profile = await learnerProfile();
    if (!profile) return null;
    return {
      ...profile,
      strengths: parseList(profile.strengths),
      weakAreas: parseList(profile.weak_areas),
      weak_areas: parseList(profile.weak_areas),
      commonMistakes: parseList(profile.common_mistakes),
      common_mistakes: parseList(profile.common_mistakes),
    };
  },

  generateLesson: async (situation) => {
    const lesson = await invokeAi('lesson', { situation }, { timeoutMs: AI_TIMEOUT_MS });
    // SultiTutorScreen reads `data.reply || data.lesson` for the card body and
    // spreads the whole payload into the message.
    return {
      ...lesson,
      reply: lesson?.reply || lesson?.lesson || lesson?.text || '',
      lesson: lesson?.lesson || lesson?.text || '',
      situation: lesson?.situation || situation,
    };
  },

  // =========================================================================
  // Conversation / History
  // =========================================================================

  getConversations: async () => api.getHistory(),

  getHistory: async () => {
    const conversations = await rows(
      await table('conversations')
        .select('conversation_id, title, created_at')
        .order('created_at', { ascending: false })
        .limit(100)
    );
    if (!conversations.length) return [];

    const ids = conversations.map((c) => c.conversation_id);
    const messages = await rows(
      await table('conversation_messages')
        .select('message_id, conversation_id, sender, message, translated_message')
        .in('conversation_id', ids)
        .order('message_id', { ascending: true })
    );

    const byConversation = new Map();
    for (const msg of messages) {
      if (!byConversation.has(msg.conversation_id)) byConversation.set(msg.conversation_id, []);
      byConversation.get(msg.conversation_id).push(msg);
    }

    return conversations.map((c) => ({
      id: String(c.conversation_id),
      conversation_id: c.conversation_id,
      title: c.title,
      createdAt: c.created_at,
      created_at: c.created_at,
      messages: (byConversation.get(c.conversation_id) || [])
        .filter((m) => m.message)
        .map((m) => ({
          role: m.sender || 'user',
          type: m.sender || 'user',
          text: m.message,
          ...(m.translated_message ? { translatedMessage: m.translated_message } : {}),
        })),
    }));
  },

  saveConversation: async (messages, title) => {
    const userId = await getUserId();
    const createdAt = new Date().toISOString();
    const conversation = await insertRow('conversations', {
      user_id: userId,
      title: title || null,
    });

    const normalized = (Array.isArray(messages) ? messages : []).map((m) => ({
      conversation_id: conversation.conversation_id,
      sender: String(m?.role || m?.type || 'user'),
      message: String(m?.text ?? m?.message ?? m?.content ?? ''),
      translated_message: m?.translatedMessage ?? m?.translation ?? null,
    }));
    if (normalized.length) await insertRows('conversation_messages', normalized);

    return {
      id: String(conversation.conversation_id),
      conversation_id: conversation.conversation_id,
      title: title || null,
      createdAt,
      created_at: createdAt,
      messages: normalized.map((m) => ({ role: m.sender, type: m.sender, text: m.message })),
    };
  },

  updateConversation: async (id, messages, title) => {
    const conversationId = Number(id);
    if (!Number.isFinite(conversationId)) throw new Error('Invalid conversation id.');

    // The client holds the authoritative transcript, so replace rather than
    // append - otherwise re-saving after each turn duplicates the whole thread.
    await deleteWhere('conversation_messages', (q) => q.eq('conversation_id', conversationId));
    if (title) {
      await updateWhere('conversations', { title }, (q) => q.eq('conversation_id', conversationId));
    }

    const normalized = (Array.isArray(messages) ? messages : []).map((m) => ({
      conversation_id: conversationId,
      sender: String(m?.role || m?.type || 'user'),
      message: String(m?.text ?? m?.message ?? m?.content ?? ''),
      translated_message: m?.translatedMessage ?? m?.translation ?? null,
    }));
    if (normalized.length) await insertRows('conversation_messages', normalized);

    return { id: String(conversationId), conversation_id: conversationId, title, messages: normalized };
  },

  deleteHistory: async (id) => {
    const conversationId = Number(id);
    if (!Number.isFinite(conversationId)) throw new Error('Invalid conversation id.');
    // conversation_messages cascades.
    await deleteWhere('conversations', (q) => q.eq('conversation_id', conversationId));
    return { deleted: true };
  },

  // =========================================================================
  // AI / translation / speech (Edge Function `ai`)
  // =========================================================================

  chat: (message, language, character) =>
    invokeAi('dialect_chat', { message, language, character }, { timeoutMs: AI_TIMEOUT_MS }),

  groqChat: (messages, nativeLanguage) => {
    const transcript = (Array.isArray(messages) ? messages : [])
      .filter((m) => m?.role !== 'system')
      .map((m) => String(m?.content ?? m?.text ?? ''))
      .join('\n');
    return invokeAi('tutor_chat', { message: transcript }, { timeoutMs: AI_TIMEOUT_MS });
  },

  translate: (text, from, to) => invokeAi('translate', { text, from, to }),
  transcribe: (audio, language) => invokeAi('dialect_voice', { audio, language }),
  getVoices: () => invokeAi('voices'),
  analyzeNLP: (text) => invokeAi('analyze', { text }),
  detectLanguage: (text) => invokeAi('detect', { text }),
  checkPronunciation: (text) => invokeAi('pronunciation_check', { expected_text: text }),

  checkPronunciationAudio: async (audioBase64, expectedText, language) => {
    const result = await invokeAi(
      'pronunciation_check',
      { audio: audioBase64, expected_text: expectedText, language: language || 'ceb' },
      { timeoutMs: AI_TIMEOUT_MS }
    );

    // Persist the attempt so Pronunciation Lab, the daily "Voice Practice"
    // challenge and getPronunciationStats() all have something to read.
    try {
      const userId = await getUserId();
      await insertRow('pronunciation_attempts', {
        id: randomId('pron'),
        user_id: userId,
        word: expectedText || result?.transcription || '',
        phonetic_expected: expectedText || '',
        phonetic_heard: result?.transcription || '',
        accuracy: num(result?.score),
        confidence: num(result?.score) / 100,
        mistakes: JSON.stringify(result?.phoneme_breakdown || []),
        lesson_context: language || 'ceb',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[api] Could not record pronunciation attempt:', err.message);
    }

    return {
      transcription: null,
      score: 0,
      feedback: '',
      phoneme_breakdown: [],
      metrics: {
        pitch_accuracy: 0,
        formant_accuracy: 0,
        energy_consistency: 0,
        speaking_rate: 0,
      },
      ...result,
    };
  },

  recommendPhrases: (situation, language) => invokeAi('recommend', { situation, language }),

  // =========================================================================
  // Vocabulary exercises (formerly the dead /api/roberta/* surface)
  // =========================================================================

  aiAvailable: () => invokeAi('capabilities'),

  generateVocabExercise: (difficulty) =>
    invokeAi('vocab_exercise', { difficulty: difficulty || 'beginner' }),

  completeSentence: (text) => invokeAi('sentence_complete', { text }),

  /**
   * Cloud TTS was removed: Edge TTS refuses cloud egress IPs and OpenRouter's
   * Flux TTS model is delisted. `src/utils/tts.js` synthesises on-device via
   * expo-speech, so nothing calls this any more - it fails loudly rather than
   * pretending to work.
   */
  ttsSynthesize: async () => {
    throw new Error('Cloud text-to-speech is unavailable. Speech is synthesised on-device.');
  },

  // =========================================================================
  // Saved phrases
  // =========================================================================

  getSavedPhrases: async () => {
    const data = await rows(
      await table('saved_phrases')
        .select('phrase_id, phrase, language, category, created_at')
        .order('phrase_id', { ascending: false })
    );
    return data.map(serializeSavedPhrase);
  },

  savePhrase: async (phrase, language, category) => {
    const userId = await getUserId();
    const created = await insertRow('saved_phrases', {
      user_id: userId,
      phrase,
      language: language || null,
      category: category || null,
    });
    return serializeSavedPhrase(created);
  },

  deleteSavedPhrase: async (id) => {
    await deleteWhere('saved_phrases', (q) => q.eq('phrase_id', id));
    return { deleted: true };
  },

  // =========================================================================
  // Notifications
  // =========================================================================

  getNotifications: async () => {
    const data = await rows(
      await table('notifications')
        .select('notify_id, user_id, title, message, is_read, created_at')
        .order('notify_id', { ascending: false })
        .limit(100)
    );
    return data.map(serializeNotification);
  },

  markNotificationRead: async (id) => {
    await updateWhere('notifications', { is_read: 1 }, (q) => q.eq('notify_id', id));
    return { success: true };
  },

  markAllNotificationsRead: async () => {
    await updateWhere('notifications', { is_read: 1 }, () => {});
    return { success: true };
  },

  // =========================================================================
  // Community
  // =========================================================================

  getCommunityPosts: async () => {
    // `post_feed` (created in 20261006_auth_provisioning.sql) joins the author
    // name and comment count server-side. RLS on `users` only exposes the
    // caller's own row, so an embed or a client-side join cannot resolve other
    // people's names - the view is the only workable path.
    try {
      const data = await rows(
        await table('post_feed')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50)
      );
      return data.map((row) => serializePost(row));
    } catch (err) {
      console.warn('[api] post_feed unavailable, falling back to community_posts:', err.message);
    }

    const fallback = await rows(
      await table('community_posts')
        .select('post_id, user_id, title, content, phrase, translation, category, likes_count, created_at')
        .order('created_at', { ascending: false })
        .limit(50)
    );
    const me = await api.getProfile().catch(() => null);
    return fallback.map((row) =>
      serializePost(
        {
          id: row.post_id,
          user_id: row.user_id,
          title: row.title,
          content: row.content,
          phrase: row.phrase,
          translation: row.translation,
          created_at: row.created_at,
          likes: row.likes_count,
          comments: 0,
        },
        row.user_id === me?.id ? me.name : 'Anonymous',
        row.category
      )
    );
  },

  createCommunityPost: async ({ type, title, content, phrase, translation } = {}) => {
    if (!title || !content) throw new Error('Title and content are required');
    const userId = await getUserId();
    const category = POST_TYPE_KEYS.includes(type) ? type : 'discussion';

    const created = await insertRow('community_posts', {
      user_id: userId,
      title,
      content,
      phrase: phrase || null,
      translation: translation || null,
      category,
      likes_count: 0,
      bookmarks_count: 0,
      is_featured: 0,
    });

    const postId = created.post_id;
    try {
      const feed = await rows(await table('post_feed').select('*').eq('id', postId).maybeSingle());
      if (feed[0]) return serializePost(feed[0]);
    } catch {
      /* view unavailable - fall through to the locally built row */
    }

    const me = await api.getProfile().catch(() => null);
    return serializePost(
      {
        id: postId,
        user_id: userId,
        title,
        content,
        phrase,
        translation,
        created_at: created.created_at,
        likes: 0,
        comments: 0,
      },
      me?.name,
      category
    );
  },

  getPostComments: async (postId) => {
    try {
      const data = await rows(
        await table('comment_feed')
          .select('*')
          .eq('post_id', postId)
          .order('created_at', { ascending: true })
      );
      return data;
    } catch (err) {
      console.warn('[api] comment_feed unavailable, falling back to comments:', err.message);
    }
    const fallback = await rows(
      await table('comments')
        .select('comment_id, post_id, user_id, comment, created_at')
        .eq('post_id', postId)
        .order('comment_id', { ascending: true })
    );
    const me = await api.getProfile().catch(() => null);
    return fallback.map((row) => ({
      id: row.comment_id,
      comment_id: row.comment_id,
      post_id: row.post_id,
      user_id: row.user_id,
      author_name: row.user_id === me?.id ? me.name : 'Anonymous',
      comment: row.comment,
      created_at: row.created_at,
    }));
  },

  createPostComment: async (postId, comment) => {
    if (!comment) throw new Error('Comment is required');
    const userId = await getUserId();
    const created = await insertRow('comments', {
      post_id: Number(postId),
      user_id: userId,
      comment,
    });
    const me = await api.getProfile().catch(() => null);
    return {
      id: created.comment_id,
      comment_id: created.comment_id,
      post_id: Number(postId),
      user_id: userId,
      author_name: me?.name || 'Anonymous',
      comment,
      created_at: created.created_at,
    };
  },

  getCommunityResources: async () => {
    const data = await rows(
      await table('community_posts')
        .select('post_id, phrase, translation, category, title, content, created_at')
        .not('phrase', 'is', null)
        .order('post_id', { ascending: false })
        .limit(100)
    );
    return data.map((row) => ({
      id: String(row.post_id),
      phrase: row.phrase,
      translation: row.translation,
      category: row.category,
      title: row.title,
      content: row.content,
      created_by: null,
      createdAt: row.created_at,
    }));
  },

  postCommunityResource: async (phrase, translation, category) => {
    const userId = await getUserId();
    const created = await insertRow('community_posts', {
      user_id: userId,
      title: phrase,
      content: translation || '',
      phrase,
      translation: translation || null,
      category: category || 'vocabulary',
    });
    return { id: String(created.post_id), phrase, translation, category };
  },

  followUser: async (userId) => {
    const me = await getUserId();
    const target = Number(userId);
    const existing = await rows(
      await table('follows').select('id').eq('follower_id', me).eq('following_id', target).maybeSingle()
    );
    if (!existing[0]) {
      await insertRow('follows', { follower_id: me, following_id: target });
    }
    return { following: true };
  },

  unfollowUser: async (userId) => {
    const me = await getUserId();
    await deleteWhere('follows', (q) => q.eq('follower_id', me).eq('following_id', Number(userId)));
    return { following: false };
  },

  getFollowers: async (userId) => {
    const target = Number(userId);
    const links = await rows(
      await table('follows').select('follower_id').eq('following_id', target)
    );
    return links.map((l) => ({ id: l.follower_id }));
  },

  getFollowing: async (userId) => {
    const me = Number(userId) || (await getUserId());
    const links = await rows(await table('follows').select('following_id').eq('follower_id', me));
    return links.map((l) => ({ id: l.following_id }));
  },

  // =========================================================================
  // Learning path
  // =========================================================================

  getLearningModules: async () =>
    rows(
      await table('learning_modules')
        .select('module_id, module_title, module_key, sort_order, difficulty, language')
        .order('sort_order', { ascending: true })
        .order('module_id', { ascending: true })
    ),

  getLearningModuleLessons: async (moduleKey) => {
    const modules = await rows(
      await table('learning_modules').select('module_id, module_key, module_title').eq('module_key', moduleKey).limit(1)
    );
    const module = modules[0];
    if (!module) throw new Error('Module not found');

    const items = await rows(
      await table('lesson_items')
        .select('item_id, module_id, section_title, native_text, english_text, note, sort_order')
        .eq('module_id', module.module_id)
        .order('sort_order', { ascending: true })
        .order('item_id', { ascending: true })
    );

    const progress = await rows(
      await table('learning_progress')
        .select('completion_percent')
        .eq('module_id', module.module_id)
        .maybeSingle()
    );

    return {
      moduleKey: module.module_key,
      moduleId: module.module_id,
      items: items.map((item) => ({
        itemId: item.item_id,
        moduleId: item.module_id,
        sectionTitle: item.section_title,
        nativeText: item.native_text,
        englishText: item.english_text ?? '',
        note: item.note ?? '',
      })),
      progress: { completionPercent: clampPercent(progress[0]?.completion_percent) },
    };
  },

  getLearningProgress: async () => {
    const modules = await api.getLearningModules();
    const stored = await rows(
      await table('learning_progress').select('module_id, completion_percent, mastery_score, updated_at')
    );
    const byModule = new Map(stored.map((s) => [s.module_id, s]));
    return modules.map((m) => serializeProgressRow(m, byModule.get(m.module_id)));
  },

  updateLearningProgress: (module_id, completion_percent) =>
    api.updateLearningProgressByKey(null, completion_percent, module_id),

  updateLearningProgressByKey: async (module_key, completion_percent, moduleId = null) => {
    const percent = clampPercent(completion_percent);
    let resolvedId = Number(moduleId);
    if (!resolvedId && module_key) {
      const found = await rows(
        await table('learning_modules').select('module_id').eq('module_key', module_key).limit(1)
      );
      resolvedId = found[0]?.module_id;
    }
    if (!resolvedId) throw new Error('A valid module_id or module_key is required');

    const userId = await getUserId();
    const existing = await rows(
      await table('learning_progress')
        .select('progress_id')
        .eq('user_id', userId)
        .eq('module_id', resolvedId)
        .maybeSingle()
    );

    const payload = {
      user_id: userId,
      module_id: resolvedId,
      completion_percent: percent,
      updated_at: new Date().toISOString(),
    };

    if (existing[0]) {
      await updateWhere('learning_progress', payload, (q) => q.eq('progress_id', existing[0].progress_id));
    } else {
      await insertRow('learning_progress', payload);
    }

    return { moduleId: resolvedId, module_id: resolvedId, completionPercent: percent, completion_percent: percent };
  },

  getLearningDashboard: async () => {
    const path = await api.getLearningProgress();
    const started = path.filter((p) => p.completionPercent > 0);
    const next = path.find((p) => p.completionPercent < 100) || null;
    const total = path.length;
    return {
      language: 'Bisaya / Cebuano',
      summary: {
        totalModules: total,
        modulesStarted: started.length,
        modulesCompleted: path.filter((p) => p.completionPercent >= 100).length,
        courseProgress: total
          ? Math.round(path.reduce((sum, p) => sum + p.completionPercent, 0) / total)
          : 0,
      },
      continue: next
        ? {
            moduleKey: next.moduleKey,
            moduleId: next.moduleId,
            title: next.moduleTitle,
            index: path.indexOf(next),
            pct: next.completionPercent,
            status: next.completionPercent > 0 ? 'in_progress' : 'upcoming',
          }
        : null,
      recommendation: { available: false, reason: 'Complete a few lessons and SULTI will personalize this for you.' },
    };
  },

  // =========================================================================
  // Settings
  // =========================================================================

  getUserSettings: async () => {
    const row = unwrap(await table('user_settings').select('*').maybeSingle());
    if (!row) return { dark_mode: 0, speech_speed: 1.0, voice_gender: 'neutral' };
    return {
      dark_mode: toBool(row.dark_mode) ? 1 : 0,
      speech_speed: num(row.speech_speed, 1.0),
      voice_gender: row.voice_gender || 'neutral',
    };
  },

  updateUserSettings: async (settings = {}) => {
    const userId = await getUserId();
    const patch = {};
    if (settings.dark_mode !== undefined) patch.dark_mode = settings.dark_mode ? 1 : 0;
    if (settings.speech_speed !== undefined) patch.speech_speed = num(settings.speech_speed, 1.0);
    if (settings.voice_gender !== undefined) patch.voice_gender = settings.voice_gender;
    if (!Object.keys(patch).length) return { message: 'Settings updated successfully' };

    // Read-then-write rather than an upsert: `user_settings.user_id` is UNIQUE
    // but its constraint name is auto-generated, and PostgREST's `on_conflict`
    // needs that exact name.
    const existing = await rows(
      await table('user_settings').select('setting_id').eq('user_id', userId).maybeSingle()
    );
    if (existing[0]) {
      await updateWhere('user_settings', patch, (q) => q.eq('setting_id', existing[0].setting_id));
    } else {
      await insertRow('user_settings', { user_id: userId, ...patch });
    }
    return { message: 'Settings updated successfully' };
  },

  updateLanguageSettings: async (native_language, learning_language) => {
    await api.updateProfile({
      native_language,
      target_language: learning_language,
    });
    return {
      message: 'Settings updated successfully',
      native_language,
      learning_language,
    };
  },

  // =========================================================================
  // Feedback
  // =========================================================================

  submitFeedback: async (functionality, usability, reliability) => {
    const userId = await getUserId();
    await insertRow('feedback', {
      user_id: userId,
      functionality: num(functionality),
      usability: num(usability),
      reliability: num(reliability),
    });
    return { success: true };
  },

  // =========================================================================
  // Gamification
  // =========================================================================

  getGameStats: async () => {
    const profile = await learnerProfile();
    return {
      xp: num(profile?.total_xp),
      coins: num(profile?.coins),
      streak: num(profile?.streak),
      daily_xp: num(profile?.daily_xp),
      daily_goal: num(profile?.daily_goal, 50),
      level: profile?.level || 'beginner',
      // Hearts are deliberately absent: `learner_profiles` has no such column,
      // and GameContext has always treated them as a device-local resource that
      // refills on a timer rather than something the server tracks.
    };
  },

  updateGameStats: async (data = {}) => {
    const userId = await getUserId();
    const profile = await requireProfile();

    const patch = { last_active: new Date().toISOString() };
    if (data.xp != null) patch.total_xp = Math.max(0, Math.round(num(data.xp)));
    if (data.coins != null) patch.coins = Math.max(0, Math.round(num(data.coins)));
    if (data.streak != null) patch.streak = Math.max(0, Math.round(num(data.streak)));
    if (data.daily_xp != null) patch.daily_xp = Math.max(0, Math.round(num(data.daily_xp)));

    if (Object.keys(patch).length > 1) {
      await updateWhere('learner_profiles', patch, (q) => q.eq('user_id', userId));
    }

    // `total_xp` is cumulative, so the growth since the last sync is what was
    // earned today. Rolling that into daily_activity is what makes the weekly
    // XP chart real now that tutor_sessions is no longer written.
    const delta = num(profile.total_xp) - num(patch.total_xp ?? profile.total_xp);
    if (delta > 0) await bumpDailyActivity(userId, delta);

    return { success: true };
  },

  getLeaderboard: async (period = 'weekly') => {
    const days = period === 'weekly' ? 7 : period === 'monthly' ? 30 : 365;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const data = await rows(
      await table('leaderboard').select('*').order('total_xp', { ascending: false }).limit(50)
    );

    return data
      .filter((row) => !row.last_active || row.last_active >= since)
      .map((row, index) => ({
        id: row.supabase_id || row.user_id,
        user_id: row.user_id,
        name: row.fullname || 'Anonymous',
        avatar: row.avatar_image || null,
        xp: num(row.total_xp),
        total_xp: num(row.total_xp),
        streak: num(row.streak),
        level: row.level,
        rank: index + 1,
      }));
  },

  claimDailyReward: async () => {
    const userId = await getUserId();
    const today = utcDateKey();
    const reward = { xp: 50, coins: 25 };

    // The unique (user_id, activity_date) index doubles as the once-per-day
    // claim guard, exactly as it did in learner.repo.ts.
    const inserted = await upsert(
      'daily_activity',
      { user_id: userId, activity_date: today, xp_earned: reward.xp },
      'idx_daily_activity_user_date',
      { ignoreDuplicates: true }
    );

    if (!inserted.length) return { claimed: false, reward: { xp: 0, coins: 0 } };

    await awardXp({
      xp: reward.xp,
      coins: reward.coins,
      source: 'daily_reward',
      idempotencyKey: `daily_reward:${userId}:${today}`,
    });
    return { claimed: true, reward };
  },

  // =========================================================================
  // Achievements / badges
  // =========================================================================

  getAchievements: async () => {
    const userId = await getUserId();
    const data = await rows(
      await table('user_achievements')
        .select('user_achievement_id, achievement_id, unlocked_at')
        .order('unlocked_at', { ascending: false })
    );
    return data.map((row) => ({
      id: row.achievement_id,
      unlockedAt: row.unlocked_at,
      user_id: userId,
    }));
  },

  getBadges: async () => {
    const data = await rows(
      await table('user_badges').select('user_badge_id, badge_id, earned_at').order('earned_at', { ascending: false })
    );
    return data.map((row) => ({ id: row.badge_id, earnedAt: row.earned_at }));
  },

  checkAchievements: async (stats = {}) => {
    // GameContext has already decided locally which achievements unlocked and
    // pays out XP/coins itself; this mirrors them into the table so they
    // survive a reinstall or a new device.
    const unlocked = Array.isArray(stats.unlocked) ? stats.unlocked : [];
    if (!unlocked.length) return { unlocked: [] };
    const userId = await getUserId();
    await upsert(
      'user_achievements',
      unlocked.map((a) => ({
        user_id: userId,
        achievement_id: a.id,
        unlocked_at: a.earnedAt || new Date().toISOString(),
      })),
      'idx_user_achievements_user_achievement',
      { ignoreDuplicates: true }
    );
    return { unlocked };
  },

  // =========================================================================
  // Vocabulary / spaced repetition
  // =========================================================================

  submitVocabReview: async (phraseId, score) => {
    const userId = await getUserId();
    const id = String(phraseId);
    const existing = await rows(
      await table('vocabulary_reviews').select('*').eq('user_id', userId).eq('id', id).maybeSingle()
    );
    const previous = existing[0];
    const update = applyReview(previous, score);
    const now = new Date().toISOString();

    if (previous) {
      await updateWhere('vocabulary_reviews', update, (q) => q.eq('user_id', userId).eq('id', id));
    } else {
      await insertRow('vocabulary_reviews', {
        id,
        user_id: userId,
        word: id,
        review_count: 0,
        ease_factor: 2.5,
        interval: 1,
        mastery: 0,
        ...update,
        created_at: now,
        updated_at: now,
      });
    }
    return { success: true, ...update };
  },

  getDueForReview: async () => {
    const data = await rows(
      await table('vocabulary_reviews')
        .select('*')
        .lte('next_review', utcDateKey())
        .order('next_review', { ascending: true })
        .limit(50)
    );
    return data.map(serializeVocabulary);
  },

  /** Backs `POST /api/v2/vocabulary/review`, the path the offline queue replays. */
  reviewWord: async ({ word, quality }) => {
    if (!word) throw new Error('A word is required to record a review.');
    const userId = await getUserId();
    const existing = await rows(
      await table('vocabulary_reviews')
        .select('*')
        .eq('user_id', userId)
        .eq('word', word)
        .maybeSingle()
    );
    const previous = existing[0];
    const update = applyReview(previous, quality);
    const now = new Date().toISOString();

    if (previous) {
      await updateWhere('vocabulary_reviews', update, (q) => q.eq('id', previous.id));
    } else {
      await insertRow('vocabulary_reviews', {
        id: randomId('vocab'),
        user_id: userId,
        word,
        translation: '',
        pronunciation: '',
        category: 'saved',
        difficulty: 1,
        review_count: 0,
        ease_factor: 2.5,
        interval: 1,
        mastery: 0,
        ...update,
        created_at: now,
        updated_at: now,
      });
    }
    return { success: true, word, ...update };
  },

  // =========================================================================
  // Challenges
  // =========================================================================

  getDailyChallenge: async () => {
    const userId = await getUserId();
    const today = utcDateKey();
    const completed = await rows(
      await table('completed_challenges')
        .select('challenge_id')
        .eq('user_id', userId)
        .eq('type', 'daily')
        .gte('completed_date', today)
    );
    const done = new Set(completed.map((c) => c.challenge_id));
    return DAILY_CHALLENGES.map((c) => ({ ...c, completed: done.has(c.id), xp_reward: c.xpReward }));
  },

  getWeeklyChallenge: async () => {
    const userId = await getUserId();
    const since = weekStartKey();
    const completed = await rows(
      await table('completed_challenges')
        .select('challenge_id')
        .eq('user_id', userId)
        .eq('type', 'weekly')
        .gte('completed_date', since)
    );
    const done = new Set(completed.map((c) => c.challenge_id));
    return WEEKLY_CHALLENGES.map((c) => ({ ...c, completed: done.has(c.id), xp_reward: c.xpReward }));
  },

  completeChallenge: async (challengeId) => {
    const challenge = findChallenge(challengeId);
    if (!challenge) throw new Error('Unknown challenge');

    const userId = await getUserId();
    const today = utcDateKey();
    const type = String(challengeId).startsWith('weekly') ? 'weekly' : 'daily';

    // The Express route verified the two criteria it could check cheaply; those
    // checks are reproduced against the same tables.
    if (challengeId === 'daily_2') {
      const attempts = await rows(
        await table('pronunciation_attempts')
          .select('id')
          .gte('timestamp', `${today}T00:00:00.000Z`)
      );
      if (attempts.length < 3) throw new Error('Challenge criteria not met');
    }
    if (challengeId === 'daily_4') {
      const touched = await rows(
        await table('learning_progress')
          .select('progress_id')
          .gte('updated_at', `${today}T00:00:00.000Z`)
      );
      if (!touched.length) throw new Error('Challenge criteria not met');
    }

    const inserted = await upsert(
      'completed_challenges',
      { user_id: userId, challenge_id: challengeId, type, completed_date: today },
      'idx_completed_challenges_user_challenge_date',
      { ignoreDuplicates: true }
    );

    // An ignored conflict means this challenge was already claimed today.
    if (!inserted.length) {
      return { success: true, alreadyCompleted: true, xpReward: 0, coinReward: 0 };
    }

    await awardXp({
      xp: challenge.xpReward,
      coins: challenge.coinReward,
      source: 'challenge',
      idempotencyKey: `challenge:${userId}:${challengeId}:${today}`,
    });
    return { success: true, xpReward: challenge.xpReward, coinReward: challenge.coinReward };
  },

  // =========================================================================
  // Native speaker verification
  // =========================================================================

  submitVerification: async (audioBase64, phraseId) => {
    const userId = await getUserId();
    const created = await insertRow('verification_requests', {
      user_id: userId,
      word_id: phraseId ? Number(phraseId) : null,
      audio_path: audioBase64 ? 'inline_base64' : null,
      recorded_text: null,
      status: 'pending',
    });
    return {
      request_id: created.request_id,
      status: 'pending',
      message: 'Submitted for native speaker verification',
    };
  },

  getVerificationRequests: async () => {
    // Moderator-only upstream; RLS allows a caller to read their own requests.
    return rows(
      await table('verification_requests')
        .select('*')
        .order('request_id', { ascending: false })
        .limit(50)
    );
  },

  approveVerification: async () => {
    throw new Error('Only moderators can approve verifications.');
  },

  // =========================================================================
  // Analytics
  // =========================================================================

  getLearningAnalytics: async () => {
    const data = await rows(
      await table('learning_progress').select('module_id, completion_percent, updated_at')
    );
    const started = new Set(data.map((r) => r.module_id));
    const percents = data.map((r) => clampPercent(r.completion_percent));
    return {
      total_progress: percents.reduce((sum, p) => sum + p, 0),
      modules_started: started.size,
      avg_completion: percents.length
        ? Math.round(percents.reduce((sum, p) => sum + p, 0) / percents.length)
        : 0,
      modules_completed: data.filter((r) => clampPercent(r.completion_percent) === 100).length,
    };
  },

  /**
   * Two of the three consumers (ProfileScreen, LearnScreen) iterate this as an
   * array of `{ date, xp }`; `LearningProgressCard` expects an aggregate object.
   * The array is the contract that three call sites share, so it stays the
   * return value and the card's `Number(undefined) || 0` guards absorb the rest.
   */
  getWeeklyProgress: async () => {
    const userId = await getUserId();
    const days = [];
    for (let i = 6; i >= 0; i -= 1) {
      days.push(utcDateKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
    }
    const data = await rows(
      await table('daily_activity')
        .select('activity_date, xp_earned')
        .eq('user_id', userId)
        .in('activity_date', days)
    );
    const byDate = new Map(data.map((row) => [row.activity_date, num(row.xp_earned)]));
    return days.map((date) => ({ date, xp: byDate.get(date) || 0 }));
  },

  getStreakData: async () => {
    const userId = await getUserId();
    const data = await rows(
      await table('daily_activity')
        .select('activity_date')
        .eq('user_id', userId)
        .gte('activity_date', utcDateKey(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)))
        .order('activity_date', { ascending: false })
    );
    const activeDates = [...new Set(data.map((row) => row.activity_date))];

    let streak = 0;
    for (let i = 0; i < 400; i += 1) {
      const expected = utcDateKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
      if (activeDates.includes(expected)) streak += 1;
      else if (i === 0) continue;
      else break;
    }
    return { currentStreak: streak, activeDates };
  },

  getPronunciationStats: async () => {
    const data = await rows(
      await table('pronunciation_attempts').select('accuracy').order('timestamp', { ascending: false }).limit(500)
    );
    const scores = data.map((row) => clampPercent(row.accuracy));
    return {
      totalAttempts: data.length,
      avgAccuracy: scores.length ? scores.reduce((sum, s) => sum + s, 0) / scores.length : 0,
    };
  },

  // =========================================================================
  // Whisper AI (Philippine dialects)
  // =========================================================================

  whisperChat: (message, language) => invokeAi('dialect_chat', { message, language }),
  whisperVoice: (audio, language) => invokeAi('dialect_voice', { audio, language }),
  whisperPhrases: (topic, language) => invokeAi('dialect_phrases', { topic, language }),
  whisperLanguages: () => invokeAi('dialect_languages'),

  // =========================================================================
  // AR scenarios
  // =========================================================================

  getARScenarios: async () => ({
    scenarios: AR_SCENARIOS.map(({ id, title, subtitle, icon, gradient, objects }) => ({
      id,
      title,
      subtitle,
      icon,
      gradient,
      objectCount: objects.length,
    })),
  }),

  getARScenario: async (id) => {
    const scenario = findARScenario(id);
    if (!scenario) throw new Error('Scenario not found');
    return scenario;
  },

  getARScenarioObjects: async (id, category) => {
    const scenario = findARScenario(id) || {
      id,
      title: 'Street & Directions',
      subtitle: 'Tap objects to learn',
      icon: 'cart',
      gradient: ['#10B981', '#059669'],
      objects: [],
    };
    const objects = category
      ? scenario.objects.filter((o) => o.category === category)
      : scenario.objects;
    return { ...scenario, objects: serializeARObjects(objects) };
  },

  analyzeARImage: async (image, scenarioId, mimeType) => {
    const scenario = findARScenario(scenarioId);
    const candidates = (scenario?.objects || []).map((o) => o.id);
    const result = await invokeAi(
      'ar_analyze',
      {
        image,
        scenario_id: scenarioId,
        mime_type: mimeType || 'image/jpeg',
        candidates,
      },
      { timeoutMs: VOICE_TIMEOUT_MS }
    );

    // The model answers with catalogue ids; map back onto real objects so the
    // detail overlay has bisaya/pronunciation/usage to render.
    const detected = (result?.objects || [])
      .map((token) => matchARObject(scenario, token))
      .filter(Boolean);

    return {
      ...result,
      objects: detected.length ? detected : [],
      scenario: scenario || null,
      scenario_id: scenarioId,
    };
  },

  // =========================================================================
  // Language preservation
  // =========================================================================

  submitPreservedWord: async (data = {}) => {
    const userId = await getUserId();
    const created = await insertRow('preserved_words', {
      word: data.word,
      definition: data.definition ?? null,
      part_of_speech: data.part_of_speech ?? null,
      dialectal_region: data.dialectal_region ?? null,
      bisaya_example: data.bisaya_example ?? null,
      english_example: data.english_example ?? null,
      pronunciation_guide: data.pronunciation_guide ?? null,
      submitted_by: userId,
      source: 'learner',
      status: 'pending',
      verification_count: 0,
    });
    return { word_id: created.word_id, status: 'pending' };
  },

  getLivingLexicon: async () => {
    const data = await rows(
      await table('preserved_words')
        .select('*')
        .eq('status', 'approved')
        .order('word_id', { ascending: false })
        .limit(100)
    );
    return data.map((row) => ({ ...row, id: row.word_id }));
  },

  getPreservationCount: async () => {
    const { count } = await table('preserved_words')
      .select('word_id', { count: 'exact', head: true })
      .eq('status', 'approved');
    return { count: Number(count) || 0 };
  },

  getPreservedWords: async (status, limit = 50, offset = 0) => {
    let query = table('preserved_words').select('*');
    if (status) query = query.eq('status', status);
    const data = await rows(
      await query.order('word_id', { ascending: false }).range(offset, offset + limit - 1)
    );
    return data.map((row) => ({ ...row, id: row.word_id }));
  },

  getDialectalVariations: async (word) => {
    const data = await rows(
      await table('preserved_words')
        .select('*')
        .eq('status', 'approved')
        .ilike('word', `%${word}%`)
        .limit(50)
    );
    return data.map((row) => ({ ...row, id: row.word_id }));
  },

  verifyPreservedWord: async (wordId, status) => {
    // RLS only lets moderators verify; a normal learner gets a clear rejection
    // from the UPDATE rather than a silent no-op.
    await updateWhere('preserved_words', { status }, (q) => q.eq('word_id', wordId));
    return { word_id: wordId, status };
  },

  // =========================================================================
  // Realtime voice credentials
  // =========================================================================

  agentStatus: () => invokeAgentToken({ action: 'status' }),
  agentToken: () => invokeAgentToken({ action: 'xai' }),
  agentDeepgramToken: () => invokeAgentToken({ action: 'deepgram' }),

  voiceStatus: () => invokeAi('voice_status'),

  // =========================================================================
  // Offline sync queue replay
  //
  // `useOfflineSync` persists actions as `{ endpoint, method, payload }` and
  // replays them verbatim. Only four paths are ever enqueued, so they are
  // translated here rather than round-tripping a fake HTTP request.
  // =========================================================================

  postData: (path, body) => replayAction(path, body),
  putData: (path, body) => replayAction(path, body),
  patchData: (path, body) => replayAction(path, body),
};

// ---------------------------------------------------------------------------

const OFFLINE_ROUTES = [
  { match: /^\/api\/game\/stats$/, run: (body) => api.updateGameStats(body) },
  {
    match: /^\/api\/user\/me$/,
    run: (body) => api.updateProfile({ name: body?.name, country: body?.country }),
  },
  {
    match: /^\/api\/v2\/vocabulary\/review$/,
    run: (body) => api.reviewWord({ word: body?.word, quality: body?.quality }),
  },
  {
    // ProfileScreen enqueues a POST carrying `{ deleted: true }` at this path.
    match: /^\/api\/saved-phrases\/(\d+)$/,
    run: (body, match) => api.deleteSavedPhrase(Number(match[1]) ?? body?.phrase_id),
  },
];

async function replayAction(path, body) {
  const route = OFFLINE_ROUTES.find((r) => r.match.test(path));
  if (!route) throw new Error(`Offline sync cannot replay ${path}.`);
  const match = route.match.exec(path);
  return route.run(body, match);
}

export { supabase };
export default api;