// RLS-scoped data access for the serverless build.
//
// The Express server used to own every SQL statement. It is gone, so the app
// now talks to PostgREST directly through the Supabase client and Postgres does
// the authorisation: every table is protected by the policies in
// `supabase/migrations/20260904_fix_rls_policies.sql`, which all resolve
// ownership through the `get_user_id()` helper
// (`SELECT user_id FROM public.users WHERE supabase_id = auth.uid()`).
//
// Two consequences shape this module:
//
//   1. SELECT/UPDATE/DELETE need no `user_id` filter - RLS already scopes them
//      to the caller. Filtering anyway would be harmless but pointless.
//   2. INSERT *does* need the caller's integer `user_id`, because every insert
//      policy is `WITH CHECK (user_id = get_user_id())`. The client cannot
//      derive that from the JWT, so it reads its own `users` row once and
//      caches the primary key.
//
// Nothing here bypasses RLS. There is no service-role key in the APK.

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Turns a supabase-js `{ data, error }` pair into a thrown `Error` or a plain
 * value.
 *
 * Every `catch` block in the app does `err.message`, and the previous
 * `request()` wrapper always produced a real `Error`, so postgrest errors are
 * normalised into that shape here rather than leaking a `{ code, details }`
 * object to the UI.
 */
export function unwrap(result, fallbackMessage = 'Database request failed.') {
  const { data, error } = result || {};
  if (error) {
    const message = error.message || error.details || error.hint || fallbackMessage;
    const err = new Error(message);
    err.code = error.code;
    err.hint = error.hint;
    err.details = error.details;
    throw err;
  }
  return data;
}

export async function rows(result) {
  const data = unwrap(result);
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

let cachedUserId = null;
let cachedAuthId = null;

/** Call on sign-out / user switch so the next caller re-resolves ownership. */
export function invalidateIdentity() {
  cachedUserId = null;
  cachedAuthId = null;
}

/** The Supabase Auth UUID of the signed-in user, or null. */
export async function getAuthId() {
  if (cachedAuthId) return cachedAuthId;
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message || 'You are not signed in.');
  const id = data?.user?.id || null;
  if (!id) throw new Error('You are not signed in.');
  cachedAuthId = id;
  return id;
}

/** The caller's `public.users.user_id` primary key. Cached per session. */
export async function getUserId({ refresh = false } = {}) {
  if (!refresh && cachedUserId !== null) return cachedUserId;
  const authId = await getAuthId();
  const row = unwrap(
    await supabase.from('users').select('user_id').eq('supabase_id', authId).maybeSingle(),
    'Could not load your profile.'
  );
  if (!row) {
    throw new Error(
      'Your profile is still being created. Please sign out and sign in again.'
    );
  }
  cachedUserId = row.user_id;
  return cachedUserId;
}

// ---------------------------------------------------------------------------
// Thin PostgREST helpers
// ---------------------------------------------------------------------------

export function table(name) {
  return supabase.from(name);
}

/**
 * Insert one row and return it.
 *
 * `insert` needs a `.select()` to hand the generated columns back to the caller.
 * An INSERT policy is also a read policy for the new row in Postgres (`RETURNING`
 * is checked against the USING clause), so this works under RLS.
 */
export async function insertRow(tableName, row) {
  const data = unwrap(await table(tableName).insert(row).select().single());
  return data;
}

export async function insertRows(tableName, rowsToInsert) {
  if (!rowsToInsert?.length) return [];
  const data = unwrap(await table(tableName).insert(rowsToInsert).select());
  return Array.isArray(data) ? data : [];
}

/**
 * Update every row matching `apply(query)` and return the updated rows.
 * `apply` receives the PostgREST query builder so callers can add `.eq()`,
 * `.in()`, etc.
 */
export async function updateWhere(tableName, patch, apply) {
  if (!patch || Object.keys(patch).length === 0) return [];
  const data = unwrap(await apply(table(tableName).update(patch)).select());
  return Array.isArray(data) ? data : [];
}

export async function deleteWhere(tableName, apply) {
  const data = unwrap(await apply(table(tableName).delete()).select());
  return Array.isArray(data) ? data : [];
}

/**
 * Upsert on a real unique constraint.
 *
 * PostgREST resolves `on_conflict` from the table's unique indexes, so the
 * target must be covered by one - e.g. `idx_learning_progress_user_module`.
 * Passing a column list that is not uniquely indexed fails at the HTTP layer.
 */
/**
 * Upsert on a real unique constraint, returning the affected rows.
 *
 * PostgREST resolves `on_conflict` from the table's unique indexes, so the
 * target must be one of those - e.g. `idx_learning_progress_user_module`, or
 * the auto-generated `table_column_key` name of a `UNIQUE` column constraint.
 * `ignoreDuplicates: true` makes an ignored conflict return `[]` (HTTP 201 with
 * an empty body), which is how the caller tells a fresh insert from a repeat.
 */
export async function upsert(tableName, rowsToUpsert, onConflict, { ignoreDuplicates = false } = {}) {
  const data = unwrap(
    await table(tableName).upsert(rowsToUpsert, { onConflict, ignoreDuplicates }).select()
  );
  return Array.isArray(data) ? data : [];
}

export async function upsertRow(tableName, row, onConflict, { ignoreDuplicates = false } = {}) {
  const data = await upsert(tableName, row, onConflict, { ignoreDuplicates });
  return data[0] ?? null;
}

// ---------------------------------------------------------------------------
// Edge Function invocation
// ---------------------------------------------------------------------------

export const AI_FUNCTION = 'ai';
export const AGENT_TOKEN_FUNCTION = 'agent-token';

/**
 * Calls a Supabase Edge Function with the caller's JWT.
 *
 * `supabase.functions.invoke()` is deliberately not used: it exposes no
 * AbortSignal, and `VoiceModeScreen` cancels an in-flight turn when the user
 * hits stop. Doing the fetch by hand also lets timeout/network failures reuse
 * the exact error strings the screens already display.
 */
async function invokeFunction(name, body, { signal = null, timeoutMs = 45000 } = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase is not configured. Check EXPO_PUBLIC_SUPABASE_URL.');
  }

  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) {
    throw new Error('You are not signed in.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort);
  }

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${data.session.access_token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(signal?.aborted ? 'Request cancelled.' : 'Request timed out. Please try again.');
    }
    throw new Error(err?.message || 'Network request failed.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Request failed (${response.status})`);
  }

  if (!response.ok || payload?.success === false) {
    const message =
      (payload && (payload.error?.message || payload.error || payload.message || payload.detail)) ||
      `Request failed (${response.status})`;
    throw new Error(String(message));
  }

  // Edge functions in this repo answer `{ success: true, data: ... }`.
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
}

export async function invokeAi(task, body = {}, options = {}) {
  return invokeFunction(AI_FUNCTION, { task, ...body }, options);
}

export async function invokeAgentToken(body = {}, options = {}) {
  return invokeFunction(AGENT_TOKEN_FUNCTION, body, options);
}

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

export function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

/** `YYYY-MM-DD` in UTC - matches the format `daily_activity.activity_date` uses. */
export function utcDateKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Monday-anchored start of the current week, as `YYYY-MM-DD`. */
export function weekStartKey(date = new Date()) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  return utcDateKey(d);
}

/**
 * `strengths` / `weak_areas` / `common_mistakes` are TEXT columns that have been
 * written two different ways over this project's life: as a JSON array (the old
 * Drizzle repo) and as a comma-joined string (the Edge Function's `mergeCsv`).
 * Accept both rather than silently dropping one of them.
 */
export function parseList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      /* fall through to CSV */
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function randomId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}