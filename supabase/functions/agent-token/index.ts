// Realtime voice credentials, minted server-side so no provider key ever ships
// inside the APK.
//
// Replaces `server/src/routes/agent.routes.ts`:
//   GET  /api/agent/status         -> action: 'status'   (unauthenticated ok)
//   POST /api/agent/token          -> action: 'xai'      (xAI realtime secret)
//   GET  /api/agent/deepgram-token -> action: 'deepgram' (Deepgram agent token)
//
// STATUS OF BOTH PROVIDERS (verified live on 2026-10-06):
//
//   xAI       -> 403 "used all available credits or reached its monthly spending
//                limit". The code is kept because adding credit restores it with
//                no client change, but every call currently fails.
//
//   Deepgram  -> POST /v1/auth/grant returns 403 {"err_code":"FORBIDDEN",
//                "err_msg":"Insufficient permissions."}. The key itself is
//                valid (GET /v1/projects succeeds), it just lacks the Agent
//                scope. Additionally the client half is browser-only:
//                `@deepgram/agents` cannot run under React Native and
//                src/services/deepgramAgent.native.js is a hard stub, so even a
//                working token would have nothing to connect with.
//
// So in practice both providers are unavailable and the app uses the Groq batch
// path (push-to-talk: Whisper STT -> LLM -> on-device expo-speech). `status`
// now PROBES both providers and caches the result for 10 minutes instead of
// inferring availability from the presence of an env var - a key that is set
// but unusable previously produced `realtime: true`, which sent the client down
// a realtime path that could not possibly connect. When a provider key is
// fixed, the next `action: 'status'` flips to `realtime: true` on its own and
// the existing client code reconnects with no further changes.

import { withSupabase } from 'npm:@supabase/server@1.9.1';
import { fetchWithRetry } from '../_shared/groq.ts';
import { buildSultiPrompt } from '../_shared/prompts.ts';
import { loadProfile, levelHint } from '../_shared/profile.ts';

type Json = Record<string, unknown>;

function ok(data: unknown) {
  return Response.json({ success: true, data });
}

function fail(message: string, status = 500) {
  return Response.json({ success: false, error: { message } }, { status });
}

function env(name: string, fallback = ''): string {
  return Deno.env.get(name) ?? fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

const DEEPGRAM_AGENT_URL = env(
  'DEEPGRAM_AGENT_URL',
  'wss://agent.deepgram.com/v1/agent/converse'
);

const XAI_VOICE_MODEL = env('XAI_VOICE_MODEL', 'grok-voice-latest');
const XAI_VOICE = env('XAI_VOICE', 'eve');

const isDeepgramConfigured = () => !!env('DEEPGRAM_API_KEY');
const isXaiConfigured = () => !!env('XAI_API_KEY');

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface DeepgramAccessToken {
  access_token: string;
  expires_in: number;
}

/** Ported from `server/src/utils/deepgram.ts`. */
async function mintDeepgramAccessToken(ttlSeconds = 300): Promise<DeepgramAccessToken> {
  const key = env('DEEPGRAM_API_KEY');
  if (!key) throw new Error('DEEPGRAM_API_KEY not configured');

  const res = await fetchWithRetry(
    'https://api.deepgram.com/v1/auth/grant',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    },
    { retries: 2 }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Deepgram auth grant failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as DeepgramAccessToken;
  if (!data?.access_token) throw new Error('Deepgram auth grant returned no access_token');
  return data;
}

/**
 * Ported verbatim from `server/src/utils/deepgram.ts`. The `think` provider is
 * Google Gemini, which means a working Deepgram token still depends on a second
 * third party being reachable from the agent runtime.
 */
function buildDeepgramAgentSettings(): Json {
  return {
    type: 'Settings',
    audio: {
      input: { encoding: 'linear16', sample_rate: 48000 },
      output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
    },
    agent: {
      speak: { provider: { type: 'deepgram', version: 'v2', model: 'flux-hannah-en' } },
      listen: { provider: { type: 'deepgram', version: 'v2', model: 'flux-general-en' } },
      think: {
        provider: { type: 'google', model: 'gemini-3.1-flash-lite' },
        prompt: env('DEEPGRAM_AGENT_PROMPT', 'You are Sulti, a warm and encouraging Bisaya (Cebuano) language tutor. Keep every spoken turn to one or two short sentences and always end with a question so the learner speaks next. Never use markdown or emojis.'),
      },
      greeting:
        'Hi! I\'m Sulti from SultiAI, your voice tutor. What would you like to practise today?',
    },
  };
}

interface RealtimeClientSecret {
  value: string;
  expires_at: number;
  model: string;
}

/** Ported from `server/src/utils/xai.ts`. */
async function getRealtimeClientSecret(): Promise<RealtimeClientSecret> {
  const key = env('XAI_API_KEY');
  if (!key) throw new Error('XAI_API_KEY not configured');

  const res = await fetchWithRetry('https://api.x.ai/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expires_after: { seconds: 1800 },
      session: { model: XAI_VOICE_MODEL },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`xAI client_secrets error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as any;
  if (!data?.value) throw new Error('xAI client_secrets returned no value');
  return { value: data.value, expires_at: data.expires_at, model: XAI_VOICE_MODEL };
}

/**
 * Same reasoning as `probeXai`: a key that is present but missing the Agent
 * scope answers 403 "Insufficient permissions.", so `configured` alone would
 * advertise a live agent that cannot connect. Cached for the same TTL - the
 * probe mints a genuine access token.
 */
const DEEPGRAM_PROBE_TTL_MS = 10 * 60 * 1000;
let deepgramProbe: { at: number; ok: boolean; detail: string } | null = null;

async function probeDeepgram(): Promise<{ ok: boolean; detail: string }> {
  if (!isDeepgramConfigured()) return { ok: false, detail: 'DEEPGRAM_API_KEY not set' };

  const now = Date.now();
  if (deepgramProbe && now - deepgramProbe.at < DEEPGRAM_PROBE_TTL_MS) return deepgramProbe;

  try {
    await mintDeepgramAccessToken(300);
    deepgramProbe = { at: now, ok: true, detail: '' };
  } catch (err: any) {
    deepgramProbe = { at: now, ok: false, detail: err?.message || String(err) };
  }
  return deepgramProbe;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const PUSH_TO_TALK_MESSAGE =
  'Realtime streaming voice is unavailable, so voice mode uses push-to-talk: ' +
  'Groq Whisper for speech recognition, Groq for the reply, and on-device ' +
  'speech synthesis.';

/**
 * xAI availability is probed for real rather than inferred from the presence of
 * XAI_API_KEY.
 *
 * With the key set but the team out of credits, `client_secrets` answers 403
 * "used all available credits or reached its monthly spending limit". Reporting
 * `realtime: true` on the strength of a non-empty env var sent the client down
 * the realtime path and then failed the connection, which reads as "voice is
 * broken" rather than "voice is on the fallback and working".
 *
 * The probe mints a real short-lived secret, so the result is cached briefly to
 * keep a status poll from minting a secret per request.
 */
const XAI_PROBE_TTL_MS = 10 * 60 * 1000;
let xaiProbe: { at: number; ok: boolean; detail: string } | null = null;

async function probeXai(): Promise<{ ok: boolean; detail: string }> {
  if (!isXaiConfigured()) return { ok: false, detail: 'XAI_API_KEY not set' };

  const now = Date.now();
  if (xaiProbe && now - xaiProbe.at < XAI_PROBE_TTL_MS) return xaiProbe;

  try {
    await getRealtimeClientSecret();
    xaiProbe = { at: now, ok: true, detail: '' };
  } catch (err: any) {
    xaiProbe = { at: now, ok: false, detail: err?.message || String(err) };
  }
  return xaiProbe;
}

async function handleStatus() {
  const [xai, deepgram] = await Promise.all([probeXai(), probeDeepgram()]);

  const mode = xai.ok ? 'realtime' : deepgram.ok ? 'deepgram_agent' : 'push_to_talk';

  const notes: string[] = [];
  if (!xai.ok) notes.push(`xAI realtime unavailable (${xai.detail})`);
  if (!deepgram.ok) notes.push(`Deepgram live agent unavailable (${deepgram.detail})`);

  return ok({
    realtime: xai.ok,
    xai: { configured: isXaiConfigured(), available: xai.ok, detail: xai.detail || null },
    deepgram: {
      configured: isDeepgramConfigured(),
      available: deepgram.ok,
      url: DEEPGRAM_AGENT_URL,
      detail: deepgram.detail || null,
    },
    local_available: false,
    mode,
    message: xai.ok
      ? 'Realtime voice mode enabled'
      : deepgram.ok
        ? 'Deepgram live voice agent available'
        : [PUSH_TO_TALK_MESSAGE, ...notes].join(' '),
  });
}

async function handleXai(supabase: any) {
  if (!isXaiConfigured()) {
    return fail(
      'Realtime voice mode requires XAI_API_KEY. Voice mode uses push-to-talk ' +
        '(Groq STT/LLM + on-device speech) instead.',
      503
    );
  }

  // The level hint is best-effort: a profile read failure must not stop the
  // caller from getting a token.
  const profile = await loadProfile(supabase);

  let secret: RealtimeClientSecret;
  try {
    secret = await getRealtimeClientSecret();
  } catch (err: any) {
    return fail(
      `Failed to mint xAI realtime token: ${err?.message || 'unknown error'}`,
      502
    );
  }

  return ok({
    token: secret.value,
    expires_at: secret.expires_at,
    url: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(secret.model)}`,
    session: {
      model: secret.model,
      voice: XAI_VOICE,
      instructions: buildSultiPrompt('voice', levelHint(profile)),
    },
  });
}

async function handleDeepgram() {
  if (!isDeepgramConfigured()) {
    return fail(
      'Deepgram live agent requires DEEPGRAM_API_KEY. Voice mode uses ' +
        'push-to-talk (Groq STT/LLM + on-device speech) instead.',
      503
    );
  }

  try {
    const { access_token, expires_in } = await mintDeepgramAccessToken(300);
    return ok({
      access_token,
      expires_in,
      url: DEEPGRAM_AGENT_URL,
      settings: buildDeepgramAgentSettings(),
    });
  } catch (err: any) {
    // 403 here almost always means the key lacks the Agent scope rather than
    // that the key is wrong, so say so — it saves a support round-trip.
    const detail = err?.message || String(err);
    const hint = /Insufficient permissions/i.test(detail)
      ? ' The DEEPGRAM_API_KEY is valid but is missing the Agent permission; ' +
        'grant it on the Deepgram console and redeploy.'
      : '';
    return fail(`Failed to mint Deepgram agent token: ${detail}${hint}`, 502);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: { Allow: 'GET,POST,OPTIONS' } });
    }

    const url = new URL(req.url);
    let body: Json = {};
    if (req.method === 'POST') {
      try {
        body = (await req.json()) as Json;
      } catch {
        /* an empty body is fine; the action falls back to the query param */
      }
    }

    const action = str(body.action) || url.searchParams.get('action') || '';

    try {
      switch (action) {
        case 'status':
          return await handleStatus();
        case 'xai':
          return await handleXai(ctx.supabase);
        case 'deepgram':
          return await handleDeepgram();
        default:
          return fail(
            `Unknown action "${action}". Supported: status, xai, deepgram`,
            400
          );
      }
    } catch (err: any) {
      const message = err?.message || 'Agent token request failed';
      return fail(message, /xAI|Deepgram/i.test(message) ? 502 : 500);
    }
  }),
};
