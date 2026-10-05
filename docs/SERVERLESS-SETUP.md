# SultiAI without a backend

This is the runbook for the serverless architecture: an Android APK that talks
straight to Supabase, with no Node/Express process, no VPS, no PM2 and no Nginx.

The Express app in `server/` is still in the repository as historical
reference. Nothing in the production path depends on it any more.

## Current status: there is no working APK yet

The code migration is complete, but **no APK has been built from it**. The only
APK on disk is `web/downloads/sultiai-1.0.0.apk`, which was built from the
Express-server version on 2026-10-01 and therefore needs a running Node backend
to do anything.

Two credentials are blocking the remaining steps, both of which require a
dashboard session you hold:

| # | Needed for | Where to get it |
| --- | --- | --- |
| 1 | `supabase db push`, `supabase secrets set`, `supabase functions deploy` | A Supabase **access token**: dashboard → Account → Access Tokens → generate (`sbp_...`). Alternatively just the **database password** for the migrations alone. |
| 2 | Signup email beyond 2/hour | A **Resend API key** for SMTP. |

Nothing in `.env`, `server/.env`, `web/.env.local`, `.pgpass` or
`.supabase/credentials.json` contains either, and `supabase projects list`
fails with `LegacyPlatformAuthRequiredError: Access token not provided`.

Until step 1 is done the app signs in but reads and writes nothing: the three
pending migrations have not created `lesson_items`, `module_key`, `sort_order`,
`completed_challenges.type` or the `handle_new_auth_user()` trigger, so every
RLS policy fails closed.

## What replaced what

| Concern | Before | After |
| --- | --- | --- |
| Auth | `POST /api/auth/signup`, `/signin`, `/google` | `supabase.auth` directly from the app |
| `public.users` row on signup | `POST /api/auth/sync-supabase` (called on every `onAuthStateChange`) | `handle_new_auth_user()` Postgres trigger |
| Dev email auto-confirm | `POST /api/auth/confirm-user` | Removed — confirmation is real |
| Chat / tutor / lessons | `POST /api/tutor/*` | `ai` Edge Function, `task: 'tutor_chat' \| 'lesson'` |
| Voice pipeline | `POST /api/voice/chat` | `ai` Edge Function, `task: 'tutor_chat', mode: 'voice'` |
| Philippine dialects | `POST /api/whisper/*` | `ai` Edge Function, `task: 'dialect_*'` |
| Translate / detect / analyze / recommend / pronunciation | `POST /api/speech/*` | `ai` Edge Function, matching `task` |
| AR image analysis | `POST /api/ar/analyze` | `ai` Edge Function, `task: 'ar_analyze'` |
| Vocabulary exercises | `POST /api/roberta/*` (a Python service that does not exist; the three `api.roberta*` methods were never even defined) | `ai` Edge Function, `task: 'vocab_exercise' \| 'sentence_complete' \| 'capabilities'` |
| Text to speech | `msedge-tts` / OpenRouter Flux TTS → `${BASE_URL}/audio/tts/*.mp3` | On-device `expo-speech` |
| Realtime voice credentials | `POST /api/agent/token`, `/deepgram-token` | `agent-token` Edge Function |
| Daily/weekly challenges | `DAILY_CHALLENGES` array inlined in `challenge.routes.ts` | `src/lib/content.js`, merged with `completed_challenges` |
| AR scenario vocabularies | `AR_SCENARIOS` array inlined in `ar.routes.ts` | `src/lib/content.js` |
| Leaderboard author names | Server-side aggregation over `users` | `leaderboard` / `post_feed` / `comment_feed` views |
| All other data (conversations, saved phrases, progress, XP, notifications, community) | Express + Drizzle repositories | Direct PostgREST reads/writes under RLS |

AI provider keys are Supabase Edge Function secrets. They are never present in
the APK, which is the entire point: an APK is a zip file that anyone can
unzip, so a key baked into the bundle is a public key.

## Provider status (verified 2026-10-06)

| Provider | Status | Notes |
| --- | --- | --- |
| Groq chat (`openai/gpt-oss-120b`) | working | HTTP 200 |
| Groq Whisper STT (`whisper-large-v3`) | working | HTTP 200 on 16 kHz mono WAV |
| Groq vision (`meta-llama/llama-4-scout-17b-16e-instruct`) | working | Used for AR image analysis, which never worked before — the Express code sent images to a text-only model |
| xAI realtime | **dead** | HTTP 403: out of credits / monthly spending limit |
| Deepgram Agent API | **dead** | `POST /v1/auth/grant` returns 403 `Insufficient permissions` — key lacks the Agent scope. Key itself is valid (`GET /v1/projects` works) |
| Deepgram TTS | **dead** | `POST /v1/text-to-speech` 404 |
| OpenRouter Flux TTS | **dead** | `deepgram/flux-tts:free` model delisted, 404 "No endpoints found" |
| Microsoft Edge TTS | **dead** | 403 from cloud IPs even with a valid `Sec-MS-GEC` token |
| `expo-speech` (on-device) | working | The only TTS path |

Consequence: voice mode is **push-to-talk** (record → Whisper STT → LLM →
`expo-speech`) on every platform. Realtime streaming was never functional on
native anyway: the Deepgram bridge was a browser-only SDK on web and a hard stub
on native. Both halves are now a single stub in `src/services/deepgramAgent.js`
with no live callers.

The `agent-token` Edge Function keeps both providers wired up and reports
honestly what is available, so adding xAI credit or granting the Deepgram key
its Agent scope is a server-side-only change.

## One-time setup

### 1. Apply the migrations

The cloud database has 39 tables but is **empty**, and three migrations are
pending. The critical one is `20261006_auth_provisioning.sql`: without the
`handle_new_auth_user()` trigger there is no `public.users` row, and every RLS
policy resolves ownership through `get_user_id()`, so the app authenticates
successfully and then reads and writes nothing.

```bash
supabase db push --linked --include-all
```

Requires the database password (Supabase → Project Settings → Database), or a
Supabase access token for the Management API.

Pending migrations:

- `20260926_learning_path_integration.sql` — adds `learning_modules.module_key`
  and `.sort_order`, creates and seeds 13 modules + 33 `lesson_items`, adds
  `learning_progress.updated_at` and the unique `(user_id, module_id)` index
- `20261001_gamification_integrity.sql` — adds `learning_sessions`,
  `learning_progress.mastery_score`, `completed_challenges.type` /
  `.completed_date`, and the idempotency-key unique indexes
- `20261006_auth_provisioning.sql` — signup provisioning (the critical one),
  the `leaderboard` / `post_feed` / `comment_feed` views, and the INSERT
  policies on `xp_logs` / `user_achievements` / `user_badges`

`20261006` also creates three views, and the reason is worth stating because it
is easy to get wrong: `leaderboard` must **not** be
`CREATE VIEW ... WITH (security_invoker = true)`. That option runs the query
with the caller's privileges, so RLS on `users` and `learner_profiles` still
applies and every caller sees exactly one row — their own. The default
(definer's privileges) is what a cross-user read requires. `post_feed` and
`comment_feed` exist for the same reason: `users` RLS exposes only your own row,
so neither a PostgREST embed (`users(fullname)`) nor a client-side join can
resolve another person's display name, and every author would silently render as
"Anonymous". The views are deliberately narrow — display name, avatar, XP,
streak, level, comment count. No emails, no learning history.

### 2. Set the AI secret

```bash
supabase secrets set --project-ref pptanwtuybivlqeyntwh \
  GROQ_API_KEY=<key> \
  GROQ_MODEL=openai/gpt-oss-120b \
  GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
```

The key currently lives in `server/.env` as `GROQ_API_KEY`. Do not commit it.

### 3. Deploy the functions

```bash
npm run functions:deploy
```

### 4. Configure SMTP

Email confirmation is enabled on the project (`mailer_autoconfirm: false`).
Supabase's built-in mailer is rate limited to **2 emails per hour**
project-wide, which makes signup testing unusable. Configure a provider:

Resend:

```
host = smtp.resend.com
port = 465
user = resend
pass = <RESEND_API_KEY>
admin_email = <a real address on the verified domain>
```

Set these in Supabase → Project Settings → Authentication → SMTP. Without this
step signup works but you cannot realistically test it.

### 5. Build

```bash
eas build -p android --profile preview
```

Local `gradle` builds are not possible on this machine — there is no Android
SDK and no `ANDROID_HOME`. EAS is the only path.

## Client architecture

- `src/services/api.js` — the single choke point, and the only place that knows
  whether a feature needs an AI provider. Its public surface (method names,
  arguments, returned shapes) is unchanged from the Express version, so no
  screen needed editing to work without the server. Where a shape had to differ
  internally — camelCase vs snake_case — the result carries both spellings
  rather than forcing call sites to change.
- `src/lib/data.js` — PostgREST helpers plus the Edge Function invoker. RLS
  already scopes SELECT/UPDATE/DELETE to the caller, but every INSERT policy is
  `WITH CHECK (user_id = get_user_id())`, so the client resolves its own
  integer `users.user_id` once and caches it. Nothing bypasses RLS; there is no
  service-role key in the APK.
- `src/lib/content.js` — the challenge and AR scenario catalogues that used to
  be inlined in Express route modules.
- `src/lib/characters.js` — the character roster, duplicated from
  `_shared/prompts.ts` so the settings picker renders without a network call.
- `src/context/UserContext.js` — auth only; all server sync calls removed.
- `src/utils/tts.js` — on-device synthesis; no HTTP, no MP3.
- `src/services/offline.js` — reachability is probed against Supabase
  (`/auth/v1/health`), not a removed Express health route.
- `src/hooks/useOfflineSync.ts` — unchanged. It stores
  `{ endpoint, method, payload }` and replays through `api.postData` /
  `putData` / `patchData`, which now route four known paths directly to their
  data-layer equivalents instead of fake HTTP.

### Two things worth knowing before editing `api.js`

`supabase.functions.invoke()` is deliberately not used. It exposes no
`AbortSignal`, and `VoiceModeScreen` cancels an in-flight turn when the user
hits stop. `invokeFunction` in `src/lib/data.js` does the fetch by hand so the
45 s voice timeout and the abort signal both work, and so failures reuse the
error strings the screens already display.

Every `catch` block in the app reads `err.message`, so PostgREST's
`{ code, details }` errors are normalised into real `Error` objects by
`unwrap()` rather than being leaked to the UI.

## Removing `server/`

Nothing imports it. `metro.config.js` already blocklists the directory so it
never enters the mobile bundle. Once you are satisfied with the APK, deleting
`server/` and the root `npm run server*` scripts is safe.
