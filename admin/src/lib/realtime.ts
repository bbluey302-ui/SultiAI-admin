'use client';

import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

/**
 * Real-time updates for the admin console.
 *
 * Each console page fetches once on mount via `useAsync`. Without this, a
 * user created or removed in Supabase (or in another admin tab) would not
 * appear until a manual refresh. This subscribes to `postgres_changes` on
 * `public.users` and bumps a version counter that pages list as a `useAsync`
 * dependency, so a change re-fetches the affected view.
 *
 * The channel rides on the shared `getSupabase()` client, which already holds
 * the signed-in administrator's session, so RLS scopes the events exactly as it
 * scopes the REST reads: an admin sees every `public.users` row (`is_admin()`),
 * so every change is broadcast to them.
 *
 * The subscription is a module-level singleton: the first subscriber opens the
 * channel, later subscribers share it, and the channel is torn down when the
 * last listener leaves.
 */

export type ChangePayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE' | string;
  table: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
};

type Listener = (payload: ChangePayload) => void;

let started = false;
const listeners = new Set<Listener>();

function start() {
  if (started) return;
  started = true;
  const client = getSupabase();
  // The channel is a module-level singleton: it lives for the session and is
  // shared by every subscriber. RLS scopes the events to what the signed-in
  // admin can already see over REST.
  client
    .channel('sultiai-admin-users')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'users' },
      (payload) => {
        listeners.forEach((listener) => listener(payload as unknown as ChangePayload));
      }
    )
    .subscribe();
}

/** Subscribe to `public.users` changes. Returns an unsubscribe function. */
export function subscribeUsers(listener: Listener): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A counter that increments on every `public.users` change. List it in a
 * `useAsync` dependency array to re-fetch when the table changes underneath
 * the page.
 */
export function useRealtimeUsersVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeUsers(() => setVersion((v) => v + 1)), []);
  return version;
}
