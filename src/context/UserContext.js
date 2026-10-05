import React, { createContext, useState, useEffect, useCallback, useContext, useRef } from 'react';
import { supabase, normalizeUser } from '../lib/supabase';
import { api } from '../services/api';

const UserContext = createContext(null);

/**
 * Pulls `role` off the caller's own `public.users` row.
 *
 * This replaces `POST /api/auth/sync-supabase`, which existed only to create
 * that row. Creation is now a Postgres trigger (`handle_new_auth_user()`), so
 * by the time we get here the row already exists and the only thing left to
 * read is the role. RLS restricts the select to the caller's own row, so no
 * filter is needed and adding one would break (the client never learns its
 * integer PK).
 *
 * Fire-and-forget by design: a role lookup failure must never block sign-in.
 */
async function refreshRoleFromDb(authUserId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('role')
      .eq('supabase_id', authUserId)
      .maybeSingle();
    if (error || !data) return null;
    return data.role || 'user';
  } catch {
    return null;
  }
}

export function UserProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [level, setLevel] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;

    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      if (!cancelled) {
        setSession(currentSession);
        setUser(normalizeUser(currentSession?.user));
        setLoading(false);
        if (currentSession?.user) {
          refreshRoleFromDb(currentSession.user.id).then((role) => {
            if (!cancelled && role) {
              setUser((prev) => (prev ? { ...prev, role } : prev));
            }
          });
        }
      }
    }).catch((err) => {
      console.warn('[UserContext] getSession error:', err.message);
      if (!cancelled) setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      if (!cancelled) {
        setSession(currentSession);
        setUser(normalizeUser(currentSession?.user));

        // Pick up the role on sign-in / token refresh / OAuth callback.
        if (currentSession?.user) {
          refreshRoleFromDb(currentSession.user.id).then((role) => {
            if (!cancelled && role) {
              setUser((prev) => (prev ? { ...prev, role } : prev));
            }
          });
        }
      }
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      subscription?.unsubscribe();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: 'sultiai://callback',
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;

      if (data?.url) {
        const { default: WebBrowser } = await import('expo-web-browser');
        const result = await WebBrowser.openAuthSessionAsync(
          data.url,
          'sultiai://callback',
          { showInRecents: true, preferEphemeralSession: false }
        );

        if (result.type === 'success') {
          return { success: true };
        } else if (result.type === 'cancel') {
          return { success: false, error: 'Sign-in was cancelled.' };
        } else {
          return { success: false, error: 'Google sign-in was dismissed or failed.' };
        }
      }

      return { success: true };
    } catch (err) {
      const message = err?.message || 'Google sign-in failed. Please try again.';
      setAuthError(message);
      return { success: false, error: message };
    }
  }, []);

  const signIn = useCallback(async (email, password) => {
    setAuthError(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      setSession(data.session);
      setUser(normalizeUser(data.user));

      // The `public.users` row is created by the `handle_new_auth_user()`
      // trigger at signup time, so there is nothing to sync here — only the
      // role to read back.
      if (data.user) {
        const role = await refreshRoleFromDb(data.user.id);
        if (role) setUser((prev) => (prev ? { ...prev, role } : prev));
      }

      return { success: true };
    } catch (err) {
      const message = err?.message || 'Sign in failed. Please try again.';
      setAuthError(message);
      return { success: false, error: message };
    }
  }, []);

  const signUp = useCallback(async (email, password, name, native_language, target_language) => {
    setAuthError(null);
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: name,
            native_language: native_language || 'English',
            target_language: target_language || 'Bisaya',
          },
        },
      });

      if (error) {
        // Handle email confirmation errors gracefully
        if (
          error.message?.includes('confirmation email') ||
          error.message?.includes('email not confirmed')
        ) {
          return {
            success: false,
            error:
              'Account created but email confirmation is pending.\n\n' +
              `Open the confirmation link we emailed to ${email}, then sign in.`,
          };
        }
        throw error;
      }

      // Email confirmation is enabled on the project (mailer_autoconfirm is
      // false), so a successful signUp with no session means "check your inbox".
      //
      // The old code tried `POST /api/auth/confirm-user` here to auto-confirm
      // for development. That endpoint is gone, and bypassing confirmation is
      // not something the client can do anyway — it would mean shipping the
      // service-role key in the APK.
      if (data.user && !data.session) {
        return { success: true, message: 'Please check your email to confirm your account.' };
      }

      setSession(data.session);
      setUser(normalizeUser(data.user));
      return { success: true };
    } catch (err) {
      const message = err?.message || 'Sign up failed. Please try again.';
      setAuthError(message);
      return { success: false, error: message };
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (err) {
      console.warn('[UserContext] Sign out error:', err.message);
    } finally {
      setSession(null);
      setUser(null);
      setAuthError(null);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (currentUser) setUser(normalizeUser(currentUser));
    } catch (e) {
      console.warn('[UserContext] Failed to refresh profile:', e.message);
    }
  }, []);

  const refreshLevel = useCallback(async () => {
    try {
      const lvl = await api.getTutorLevel();
      setLevel(lvl);
    } catch (e) {
      console.warn('[UserContext] Failed to refresh level:', e.message);
    }
  }, []);

  // Role helper functions
  const isAdmin = user?.role === 'admin';
  const isModerator = user?.role === 'moderator' || isAdmin;
  const hasPermission = useCallback((permission) => {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissions?.includes(permission) || false;
  }, [user]);

  return (
    <UserContext.Provider value={{
      user, session, loading, authError, level,
      isAdmin, isModerator, hasPermission,
      refreshLevel, signIn, signInWithGoogle, signUp, signOut, refreshProfile,
    }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be used within UserProvider');
  return ctx;
}
