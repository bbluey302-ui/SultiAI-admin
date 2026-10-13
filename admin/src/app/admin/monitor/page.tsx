'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import {
  Avatar,
  Card,
  CardHeader,
  EmptyState,
  LoadingState,
  RoleBadge,
  StatusBadge,
  tableHeadTh,
} from '@/components/ui';
import type { MonitoredUser, UserStats } from '@/types';
import { api } from '@/lib/api';
import { useRealtimeUsersVersion } from '@/lib/realtime';

const REFRESH_MS = 5000;

interface UsersResponse {
  ok: boolean;
  fetchedAt: string;
  stats?: UserStats;
  users?: MonitoredUser[];
  error?: string;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Polls the Supabase snapshot route so the table tracks `public.users` live. */
function useUsersMonitor() {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Realtime: refresh the instant a user changes instead of waiting for the
  // next poll tick. The 5s interval stays as a backstop.
  const rtVersion = useRealtimeUsersVersion();

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const body = await api.getUserMonitor();
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reach the monitor endpoint');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick, matching useAsync: setState in an effect body triggers
    // cascading renders, so the first poll is scheduled like the interval ones.
    const first = setTimeout(() => void load(), 0);
    timer.current = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  useEffect(() => {
    // Deferred a tick, matching the existing poll effect above.
    if (rtVersion > 0) {
      const t = setTimeout(() => void load(), 0);
      return () => clearTimeout(t);
    }
  }, [rtVersion, load]);

  return { data, error, refreshing, reload: load };
}

export default function MonitorPage() {
  const { data, error, refreshing, reload } = useUsersMonitor();

  const loading = !data && !error;
  const users = data?.users ?? [];
  const stats = data?.stats;
  const lastUpdated = data ? new Date(data.fetchedAt) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supabase · public.users"
        title="Users DB monitor"
        description={`Every record in public.users, refreshing every ${REFRESH_MS / 1000} seconds.`}
        meta={
          <p className="flex items-center gap-2 text-xs text-ink-faint">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                error ? 'bg-danger' : refreshing ? 'bg-warning' : 'bg-success'
              }`}
            />
            {error
              ? 'Database unreachable — retrying automatically'
              : lastUpdated
                ? `Live · updated ${lastUpdated.toLocaleTimeString('en-PH')}`
                : 'Connecting…'}
          </p>
        }
      />

      {error && (
        <Card level={1} className="border-danger/30 p-5">
          <p className="text-sm font-semibold text-danger">Cannot reach Supabase</p>
          <p className="mt-1 font-mono text-xs break-all text-ink-soft">{error}</p>
          <p className="mt-2 text-xs text-ink-faint">
            The console could not load <span className="font-mono">public.users</span>. Check the
            Supabase project and your session, then this panel recovers on its own.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Total users" value={stats?.total ?? '—'} tone="brand" emphasis />
        <StatCard label="Verified" value={stats?.verified ?? '—'} tone="green" />
        <StatCard label="Native speakers" value={stats?.nativeSpeakers ?? '—'} tone="violet" />
        <StatCard label="Admins" value={stats?.admins ?? '—'} tone="amber" />
        <StatCard label="New · 7 days" value={stats?.newLast7Days ?? '—'} tone="green" />
        <StatCard
          label="Latest signup"
          value={stats?.latestSignup ? formatDate(stats.latestSignup) : '—'}
          tone="brand"
        />
      </div>

      <Card sheen={false}>
        <CardHeader
          title="All user records"
          subtitle={`${users.length} row${users.length === 1 ? '' : 's'} in public.users · password hashes are never exposed`}
          action={
            <button
              type="button"
              onClick={() => void reload()}
              className="press rounded-control bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink-soft ring-1 ring-line-strong/30 ring-inset hover:text-ink"
            >
              Refresh now
            </button>
          }
        />

        {loading ? (
          <LoadingState label="Loading public.users..." />
        ) : users.length === 0 && !error ? (
          <EmptyState title="No records" description="The users table is currently empty." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={tableHeadTh}>
                    ID
                  </th>
                  <th scope="col" className={tableHeadTh}>
                    User
                  </th>
                  <th scope="col" className={tableHeadTh}>
                    Languages
                  </th>
                  <th scope="col" className={tableHeadTh}>
                    Country
                  </th>
                  <th scope="col" className={tableHeadTh}>
                    Role
                  </th>
                  <th scope="col" className={tableHeadTh}>
                    Flags
                  </th>
                  <th scope="col" className={tableHeadTh}>
                    Joined
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.user_id}
                    className="border-b border-line transition-colors last:border-0 hover:bg-surface-2/50"
                  >
                    <td className="px-5 py-3.5 font-mono text-xs text-ink-faint">#{u.user_id}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.fullname} />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-ink">
                            {u.fullname}
                          </span>
                          <span className="block truncate text-xs text-ink-faint">
                            {u.username ? `@${u.username} · ` : ''}
                            {u.email}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-ink-soft">
                      {u.preferred_lang ?? '—'}
                      <span className="mx-1.5 text-ink-faint">→</span>
                      <span className="text-brand-ink">{u.learning_lang ?? '—'}</span>
                    </td>
                    <td className="px-5 py-3.5 text-sm text-ink-soft">{u.country ?? '—'}</td>
                    <td className="px-5 py-3.5">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap gap-1.5">
                        {u.is_verified === 1 && <StatusBadge status="verified" />}
                        {u.is_native_speaker === 1 && (
                          <StatusBadge status="verified" label="native" />
                        )}
                        {u.is_verified !== 1 && u.is_native_speaker !== 1 && (
                          <span className="text-xs text-ink-faint">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs whitespace-nowrap text-ink-faint">
                      {formatDate(u.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
