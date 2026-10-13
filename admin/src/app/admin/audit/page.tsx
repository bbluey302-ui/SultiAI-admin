'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Stagger, StaggerItem } from '@/components/motion';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  selectCls,
  inputCls,
  ghostBtn,
  tableHeadTh,
  tableTd,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { api } from '@/lib/api';
import { downloadCsv } from '@/lib/export';

const RESOURCE_TYPES = ['all', 'community_posts', 'comments', 'preserved_words', 'xp_logs'] as const;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function AdminAuditLogsPage() {
  const [search, setSearch] = useState('');
  const [resourceType, setResourceType] = useState<string>('all');
  const [page, setPage] = useState(1);
  const perPage = 20;

  const filters = { search, resourceType, actorId: 'all' as const };
  const { data, loading, error, reload } = useAsync(
    () => api.listAuditLogs(filters, page, perPage),
    [search, resourceType, page]
  );

  if (loading) return <LoadingState label="Loading audit logs..." />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Security"
        title="Audit Logs"
        description="Append-only trail of privileged and security-relevant events."
        meta={
          <p className="text-sm text-ink-soft">
            {total} event{total === 1 ? '' : 's'} recorded
          </p>
        }
        actions={
          <>
            {items.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  downloadCsv(
                    items.map((a) => ({
                      id: a.id,
                      timestamp: a.timestamp,
                      actor: a.actor?.name ?? '',
                      action: a.action,
                      resourceType: a.resourceType,
                      resourceId: a.resourceId ?? '',
                      details: a.details ?? '',
                    })),
                    `sultiai-audit-${new Date().toISOString().split('T')[0]}.csv`
                  )
                }
                className={ghostBtn}
              >
                Export CSV
              </button>
            )}
          </>
        }
      />

      <Stagger className="space-y-4" step={0.05}>
        <StaggerItem index={0}>
          <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search action or details…"
              className={`${inputCls} sm:max-w-xs`}
              aria-label="Search audit logs"
            />
            <select
              value={resourceType}
              onChange={(e) => {
                setResourceType(e.target.value);
                setPage(1);
              }}
              className={selectCls}
              aria-label="Filter by resource type"
            >
              {RESOURCE_TYPES.map((rt) => (
                <option key={rt} value={rt}>
                  {rt === 'all' ? 'All resources' : rt.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </Card>
        </StaggerItem>

        <StaggerItem index={1}>
          <Card level={3} className="flush overflow-hidden">
            {items.length === 0 ? (
              <EmptyState
                title="No audit events yet"
                description="Events are recorded automatically when moderators act on content, words are reviewed, or XP is awarded."
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px]">
                    <thead>
                      <tr className="border-b border-line">
                        <th className={tableHeadTh}>Time</th>
                        <th className={tableHeadTh}>Actor</th>
                        <th className={tableHeadTh}>Action</th>
                        <th className={tableHeadTh}>Resource</th>
                        <th className={tableHeadTh}>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((a) => (
                        <tr key={a.id} className="border-b border-line/60 last:border-0">
                          <td className={`${tableTd} whitespace-nowrap text-ink-soft`}>
                            {formatTime(a.timestamp)}
                          </td>
                          <td className={tableTd}>
                            {a.actor ? (
                              <span className="font-medium text-ink">{a.actor.name}</span>
                            ) : (
                              <span className="text-ink-faint">system</span>
                            )}
                          </td>
                          <td className={`${tableTd} font-medium text-ink`}>{a.action}</td>
                          <td className={tableTd}>
                            <span className="text-ink-soft">
                              {a.resourceType}
                              {a.resourceId ? ` · ${a.resourceId}` : ''}
                            </span>
                          </td>
                          <td className={`${tableTd} max-w-[280px] truncate text-ink-soft`}>
                            {a.details ?? ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between border-t border-line px-5 py-3">
                    <p className="text-xs text-ink-faint">
                      Page {page} of {totalPages}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page <= 1}
                        className={ghostBtn}
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page >= totalPages}
                        className={ghostBtn}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </StaggerItem>
      </Stagger>
    </div>
  );
}
