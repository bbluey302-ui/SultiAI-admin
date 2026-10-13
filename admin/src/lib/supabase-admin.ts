import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-only Supabase access for the admin console.
 *
 * Two clients, one rule: neither may be imported from a `'use client'` module.
 *
 *   - `serviceClient()` holds the secret key and bypasses RLS. It is the only
 *     way the console can create/delete auth users and change privileged
 *     `public.users` columns (role, status, is_verified), which the shipped
 *     migrations deliberately keep out of reach for the `authenticated` role.
 *   - `authClient()` holds the publishable key and is used only to verify a
 *     caller's access token with `auth.getUser()`.
 *
 * `requireAdmin()` is the gate: it resolves the token to a Supabase auth user,
 * then confirms `public.users.role = 'admin'` before any handler runs.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? '';

const globalForSupabase = globalThis as unknown as {
  __sultiAdminServiceClient?: SupabaseClient;
  __sultiAdminAuthClient?: SupabaseClient;
};

/** An error carrying an HTTP status the route handler can echo back. */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function assertConfigured() {
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set for the admin app.');
}

export function serviceClient(): SupabaseClient {
  assertConfigured();
  if (!SUPABASE_SECRET_KEY) {
    throw new Error('SUPABASE_SECRET_KEY is not set for the admin app.');
  }
  if (!globalForSupabase.__sultiAdminServiceClient) {
    globalForSupabase.__sultiAdminServiceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return globalForSupabase.__sultiAdminServiceClient;
}

function authClient(): SupabaseClient {
  assertConfigured();
  if (!globalForSupabase.__sultiAdminAuthClient) {
    globalForSupabase.__sultiAdminAuthClient = createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return globalForSupabase.__sultiAdminAuthClient;
}

export interface AdminIdentity {
  userId: number;
  name: string;
  email: string;
  role: string;
}

/**
 * Validates the `Authorization: Bearer <access token>` header and throws a
 * 401/403 `HttpError` unless the token belongs to a signed-in administrator.
 */
export async function requireAdmin(request: Request): Promise<AdminIdentity> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Missing session token. Please sign in again.');

  const { data, error } = await authClient().auth.getUser(token);
  if (error || !data.user) {
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }

  const { data: profile, error: profileError } = await serviceClient()
    .from('users')
    .select('user_id, fullname, email, role')
    .eq('supabase_id', data.user.id)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);
  if (!profile || profile.role !== 'admin') {
    throw new HttpError(403, 'Access denied. This account does not have admin privileges.');
  }

  return {
    userId: profile.user_id as number,
    name: (profile.fullname as string) ?? 'Admin',
    email: (profile.email as string) ?? '',
    role: profile.role as string,
  };
}
