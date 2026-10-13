'use client';

import { useSyncExternalStore } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface AdminSession {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar: string;
  signedInAt: string;
  token: string;
  refreshToken?: string;
}

const STORAGE_KEY = 'sultiai_admin_session';
const COOKIE_KEY = 'sultiai_admin_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

let currentSession: AdminSession | null = null;
let initialized = false;
const listeners = new Set<() => void>();

function readFromStorage(): AdminSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AdminSession) : null;
  } catch {
    return null;
  }
}

function ensureInit() {
  if (!initialized) {
    currentSession = readFromStorage();
    initialized = true;
  }
}

function subscribe(listener: () => void) {
  ensureInit();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  ensureInit();
  return currentSession;
}

function getServerSnapshot() {
  return null;
}

/**
 * The proxy on `/admin/:path*` gates the routes, but it only needs to know that a
 * signed-in admin exists — never the token itself. Keeping the cookie down to the
 * role means the ~600 byte JWT is not attached to every admin request.
 *
 * The value MUST be percent-encoded: RFC 6265 rejects `"` in a cookie value, and
 * an unencoded JSON payload is silently dropped, which sends the browser back to
 * the login page in a loop right after a successful sign-in.
 */
function writeCookie(role: string) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  const value = encodeURIComponent(JSON.stringify({ role }));
  document.cookie = `${COOKIE_KEY}=${value}; path=/admin; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

function clearCookie() {
  document.cookie = `${COOKIE_KEY}=; path=/admin; max-age=0; SameSite=Lax`;
}

function commit(session: AdminSession | null) {
  currentSession = session;
  if (typeof window !== 'undefined') {
    if (session) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      writeCookie(session.role);
    } else {
      localStorage.removeItem(STORAGE_KEY);
      clearCookie();
    }
  }
  listeners.forEach((l) => l());
}

export const adminSession = {
  getSession(): AdminSession | null {
    ensureInit();
    return currentSession;
  },

  /**
   * Authenticates against Supabase Auth, then confirms the account maps to a
   * `public.users` row whose role is `admin`. Anything else is signed straight
   * back out so a stray successful password check never leaves a session behind.
   */
  async signIn(email: string, password: string): Promise<AdminSession> {
    const supabase = getSupabase();

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      const message = /invalid login credentials/i.test(error.message)
        ? 'Invalid email or password.'
        : error.message;
      throw new Error(message);
    }
    if (!data.user) {
      throw new Error('Sign in failed. Please try again.');
    }

    // RLS lets a signed-in user read their own profile row.
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('user_id, fullname, email, role')
      .eq('supabase_id', data.user.id)
      .maybeSingle();

    if (profileError) {
      await supabase.auth.signOut();
      throw new Error(`Could not load your profile: ${profileError.message}`);
    }
    if (!profile || profile.role !== 'admin') {
      await supabase.auth.signOut();
      throw new Error('Access denied. This account does not have admin privileges.');
    }

    const name = (profile.fullname as string) || 'Admin';
    const session: AdminSession = {
      id: String(profile.user_id ?? ''),
      name,
      email: (profile.email as string) || email,
      role: 'admin',
      avatar: name.charAt(0).toUpperCase(),
      signedInAt: new Date().toISOString(),
      token: data.session?.access_token ?? '',
      refreshToken: data.session?.refresh_token,
    };
    commit(session);
    return session;
  },

  async signOut(): Promise<void> {
    try {
      await getSupabase().auth.signOut();
    } catch {
      // Never block sign-out on a network failure — the local session clears regardless.
    }
    commit(null);
  },
};

export function useSession() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Bearer token for `/api/admin` calls, or '' when signed out. Read from the
 * Supabase client (not our display cache) so it is always the freshest token,
 * including after a background refresh.
 */
export async function getAccessToken(): Promise<string> {
  try {
    const { data } = await getSupabase().auth.getSession();
    return data.session?.access_token ?? '';
  } catch {
    return '';
  }
}
