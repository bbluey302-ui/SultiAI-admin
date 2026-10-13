'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser-side Supabase client for the admin console.
 *
 * Carries only the publishable key, so it can do exactly what an unprivileged
 * visitor can: sign in, sign out, and read the signed-in user's own
 * `public.users` row (RLS scopes that to the owner). Every privileged read and
 * write goes through the same-origin route handlers under `/api/admin`, which
 * hold the secret key server-side.
 *
 * Sessions persist under their own storage key so the console never collides
 * with any other Supabase app running on the same origin.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      throw new Error(
        'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in admin/.env.local.'
      );
    }
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'sultiai_admin_auth',
      },
    });
  }
  return client;
}
