import { serviceClient, HttpError } from '@/lib/supabase-admin';
import type {
  AdminSettings,
  AdminUser,
  AuditLog,
  AuditLogFilters,
  AuditLogResponse,
  AiUsageStats,
  CommunityPost,
  CommunityReport,
  FeedbackItem,
  LessonModule,
  ModuleDifficulty,
  MonitorSnapshot,
  OverviewResponse,
  PreservedWord,
  ReportStatus,
  SeriesPoint,
  SystemHealth,
  TopUser,
  UserDetail,
  UserListResponse,
  UserRole,
  UserStats,
  UserStatus,
  XpOverview,
  VerificationStatus,
} from '@/types';

/**
 * Every admin read and write, expressed against Supabase.
 *
 * Called only from the catch-all route handler under `/api/admin`, after
 * `requireAdmin()` has verified the caller. `serviceClient()` bypasses RLS, so
 * each function is responsible for returning exactly the shape the console
 * renders.
 *
 * Scale note: the overview, XP and AI pages aggregate small alpha-stage tables
 * in JavaScript rather than in SQL. If a table grows into the millions of rows,
 * move these into `SECURITY DEFINER` RPCs that `GROUP BY` server-side.
 */

function svc() {
  return serviceClient();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches `src/constants/xp.ts` `LEVEL_THRESHOLDS`, so the admin agrees with the app. */
const LEVEL_THRESHOLDS = [0, 100, 250, 500, 1000, 2000, 3500, 5000];

function levelFromXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i += 1) {
    if (xp >= LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return (value[0] as T) ?? null;
  return (value as T) ?? null;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** `weak_areas` / `strengths` are TEXT columns that may hold JSON or a CSV list. */
function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value === null || value === undefined) return [];
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through to CSV parsing
    }
  }
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function dayKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

/** The last `days` calendar days in UTC, oldest first, with short labels. */
function dayKeys(days: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() - i);
    out.push({
      key: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    });
  }
  return out;
}

async function countOf(table: string): Promise<number> {
  const { count, error } = await svc().from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function countWhere(table: string, column: string, value: string | number): Promise<number> {
  const { count, error } = await svc()
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(column, value);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Voice activity is logged as `learning_sessions` rows whose `activity_type`
 * starts with `voice`. That table is optional to the console, so a missing
 * relation degrades to 0 rather than failing the whole AI page.
 */
async function countVoiceSessions(): Promise<number> {
  try {
    const { count, error } = await svc()
      .from('learning_sessions')
      .select('*', { count: 'exact', head: true })
      .ilike('activity_type', 'voice%');
    if (error) throw new Error(error.message);
    return count ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface ProfileEmbed {
  total_xp: number | null;
  streak: number | null;
  last_active: string | null;
}

interface UserRow {
  user_id: number;
  fullname: string;
  username: string | null;
  email: string;
  role: string;
  status: string;
  is_verified: number | null;
  is_native_speaker: number | null;
  country: string | null;
  google_id: string | null;
  created_at: string;
  bio: string | null;
  learner_profiles: ProfileEmbed | ProfileEmbed[] | null;
}

const USER_SELECT =
  'user_id, fullname, username, email, role, status, is_verified, is_native_speaker, country, google_id, created_at, bio, learner_profiles(total_xp, streak, last_active)';

async function fetchAllUsers(): Promise<UserRow[]> {
  const { data, error } = await svc()
    .from('users')
    .select(USER_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as UserRow[];
}

async function loadUserRow(id: number): Promise<UserRow | null> {
  const { data, error } = await svc()
    .from('users')
    .select(USER_SELECT)
    .eq('user_id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as UserRow | null) ?? null;
}

/** Completed modules per user (`learning_progress` is per module, not per lesson). */
async function completedLessonCounts(): Promise<Map<number, number>> {
  const { data, error } = await svc()
    .from('learning_progress')
    .select('user_id')
    .gte('completion_percent', 100);
  if (error) throw new Error(error.message);
  const counts = new Map<number, number>();
  for (const row of (data ?? []) as { user_id: number }[]) {
    counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  }
  return counts;
}

function toAdminUser(row: UserRow, lessons: number): AdminUser {
  const profile = one(row.learner_profiles);
  const xp = toNumber(profile?.total_xp);
  return {
    id: row.user_id,
    name: row.fullname,
    email: row.email,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    level: levelFromXp(xp),
    xp,
    streak: toNumber(profile?.streak),
    lessons,
    verified: row.is_verified === 1,
    nativeSpeaker: row.is_native_speaker === 1,
    joinedAt: row.created_at,
    lastActive: profile?.last_active ?? row.created_at,
    country: row.country ?? undefined,
    authProvider: row.google_id ? 'google' : 'email',
  };
}

export async function listUsers(query: {
  page: number;
  perPage: number;
  search: string;
  role: string;
  status: string;
  sort: string;
}): Promise<UserListResponse> {
  const [rows, lessons] = await Promise.all([fetchAllUsers(), completedLessonCounts()]);

  const search = query.search.trim().toLowerCase();
  let items = rows
    .map((row) => toAdminUser(row, lessons.get(row.user_id) ?? 0))
    .filter((user) => {
      if (query.role && query.role !== 'all' && user.role !== query.role) return false;
      if (query.status && query.status !== 'all' && user.status !== query.status) return false;
      if (!search) return true;
      return user.name.toLowerCase().includes(search) || user.email.toLowerCase().includes(search);
    });

  items = items.sort((a, b) => {
    switch (query.sort) {
      case 'xp':
        return b.xp - a.xp;
      case 'level':
        return b.level - a.level;
      case 'joined':
        return new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime();
      default:
        return new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime();
    }
  });

  const total = items.length;
  const page = Math.max(1, query.page || 1);
  const perPage = Math.max(1, query.perPage || 10);
  const start = (page - 1) * perPage;

  return { items: items.slice(start, start + perPage), total, page, perPage };
}

export async function getUserMonitor(): Promise<MonitorSnapshot> {
  const { data, error } = await svc()
    .from('users')
    .select(
      'user_id, fullname, username, email, clerk_id, google_id, supabase_id, avatar_id, preferred_lang, learning_lang, country, role, is_verified, is_native_speaker, bio, created_at'
    )
    .order('created_at', { ascending: false })
    .order('user_id', { ascending: false });
  if (error) throw new Error(error.message);

  type MonitorRow = MonitorSnapshot['users'][number];
  const users = (data ?? []) as unknown as MonitorRow[];

  const weekAgo = new Date();
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const weekAgoIso = weekAgo.toISOString();

  const stats: UserStats = {
    total: users.length,
    verified: users.filter((u) => u.is_verified === 1).length,
    nativeSpeakers: users.filter((u) => u.is_native_speaker === 1).length,
    admins: users.filter((u) => u.role === 'admin').length,
    newLast7Days: users.filter((u) => u.created_at >= weekAgoIso).length,
    latestSignup: users[0]?.created_at ?? null,
  };

  return { ok: true, fetchedAt: new Date().toISOString(), stats, users };
}

export async function listPendingUsers(): Promise<{ items: AdminUser[]; total: number }> {
  const [rows, lessons] = await Promise.all([fetchAllUsers(), completedLessonCounts()]);
  const items = rows
    .filter((row) => row.status === 'pending')
    .map((row) => toAdminUser(row, lessons.get(row.user_id) ?? 0));
  return { items, total: items.length };
}

export async function getUserDetail(id: number): Promise<{ detail: UserDetail }> {
  const row = await loadUserRow(id);
  if (!row) throw new HttpError(404, `User ${id} was not found.`);

  const [lessons, profile, badges, analytics, feedbackCount] = await Promise.all([
    completedLessonCounts().then((map) => map.get(id) ?? 0),
    svc()
      .from('learner_profiles')
      .select('weak_areas, coins, daily_goal')
      .eq('user_id', id)
      .maybeSingle(),
    svc().from('user_badges').select('badge_id').eq('user_id', id),
    svc().from('learning_analytics').select('favorite_category').eq('user_id', id).maybeSingle(),
    countWhere('feedback', 'user_id', id),
  ]);

  const base = toAdminUser(row, lessons);
  const detail: UserDetail = {
    ...base,
    badges: ((badges.data ?? []) as { badge_id: string }[]).map((b) => b.badge_id),
    weakAreas: parseList(profile.data?.weak_areas),
    favoriteCategory: (analytics.data?.favorite_category as string) ?? '',
    totalCoins: toNumber(profile.data?.coins),
    dailyGoal: toNumber(profile.data?.daily_goal, 50),
    feedbackCount,
  };
  return { detail };
}

const ROLES: UserRole[] = ['user', 'admin', 'moderator'];
const STATUSES: UserStatus[] = ['pending', 'approved', 'rejected', 'banned', 'suspended', 'active'];

export async function updateUserRole(id: number, role: UserRole): Promise<AdminUser> {
  if (!ROLES.includes(role)) throw new HttpError(400, `Unknown role "${role}".`);
  return patchUser(id, { role });
}

export async function updateUserStatus(id: number, status: UserStatus): Promise<AdminUser> {
  if (!STATUSES.includes(status)) throw new HttpError(400, `Unknown status "${status}".`);
  return patchUser(id, { status });
}

export async function setUserVerified(id: number, verified: boolean): Promise<AdminUser> {
  return patchUser(id, { is_verified: verified ? 1 : 0 });
}

async function patchUser(id: number, patch: Record<string, unknown>): Promise<AdminUser> {
  const { data, error } = await svc()
    .from('users')
    .update(patch)
    .eq('user_id', id)
    .select('user_id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(404, `User ${id} was not found.`);

  const row = await loadUserRow(id);
  if (!row) throw new HttpError(404, `User ${id} was not found.`);
  const lessons = (await completedLessonCounts()).get(id) ?? 0;
  return toAdminUser(row, lessons);
}

export async function createUser(input: {
  fullname?: string;
  email?: string;
  password?: string;
  role?: UserRole;
}): Promise<{ id: number; name: string; email: string; role: string }> {
  const fullname = (input.fullname ?? '').trim();
  const email = (input.email ?? '').trim();
  const password = input.password ?? '';
  if (!fullname || !email || !password) {
    throw new HttpError(400, 'Full name, email and password are required.');
  }
  if (password.length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters.');
  }

  const { data, error } = await svc().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullname },
  });
  if (error || !data.user) {
    throw new HttpError(400, error?.message ?? 'Could not create the account.');
  }

  const { data: row } = await svc()
    .from('users')
    .select('user_id, fullname, email, role')
    .eq('supabase_id', data.user.id)
    .maybeSingle();

  let role = (row?.role as string) ?? 'user';
  if (row && input.role && input.role !== role && ROLES.includes(input.role)) {
    const { error: roleError } = await svc()
      .from('users')
      .update({ role: input.role })
      .eq('user_id', row.user_id);
    if (roleError) throw new Error(roleError.message);
    role = input.role;
  }

  return {
    id: (row?.user_id as number) ?? 0,
    name: (row?.fullname as string) ?? fullname,
    email: (row?.email as string) ?? email,
    role,
  };
}

export async function deleteUser(id: number): Promise<void> {
  const { data, error } = await svc()
    .from('users')
    .select('user_id, supabase_id')
    .eq('user_id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return;

  const { error: deleteError } = await svc().from('users').delete().eq('user_id', id);
  if (deleteError) throw new Error(deleteError.message);

  if (data.supabase_id) {
    const { error: authError } = await svc().auth.admin.deleteUser(data.supabase_id as string);
    if (authError && !/not found/i.test(authError.message)) {
      throw new Error(authError.message);
    }
  }
}

export async function approveUser(id: number): Promise<{ id: number; status: string }> {
  await patchUser(id, { status: 'approved' });
  return { id, status: 'approved' };
}

export async function rejectUser(id: number): Promise<{ id: number; status: string }> {
  await patchUser(id, { status: 'rejected' });
  return { id, status: 'rejected' };
}

export async function bulkApproveUsers(userIds: number[]): Promise<{ approved: number }> {
  const ids = userIds.map(Number).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return { approved: 0 };
  const { data, error } = await svc()
    .from('users')
    .update({ status: 'approved' })
    .in('user_id', ids)
    .select('user_id');
  if (error) throw new Error(error.message);
  return { approved: (data ?? []).length };
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

interface ModuleRow {
  module_id: number;
  module_title: string;
  difficulty: string | null;
  language: string | null;
  is_published: number | null;
  updated_at: string | null;
  created_at: string | null;
}

export async function listLessons(): Promise<LessonModule[]> {
  const [modulesRes, itemsRes, progressRes] = await Promise.all([
    svc()
      .from('learning_modules')
      .select('module_id, module_title, difficulty, language, is_published, updated_at, created_at')
      .order('module_id', { ascending: true }),
    svc().from('lesson_items').select('module_id'),
    svc().from('learning_progress').select('module_id, completion_percent'),
  ]);
  if (modulesRes.error) throw new Error(modulesRes.error.message);

  const modules = (modulesRes.data ?? []) as unknown as ModuleRow[];

  const itemCount = new Map<number, number>();
  for (const item of (itemsRes.data ?? []) as { module_id: number }[]) {
    itemCount.set(item.module_id, (itemCount.get(item.module_id) ?? 0) + 1);
  }

  const completions = new Map<number, number>();
  const percentSum = new Map<number, number>();
  const percentCount = new Map<number, number>();
  for (const row of (progressRes.data ?? []) as {
    module_id: number;
    completion_percent: number | null;
  }[]) {
    if (toNumber(row.completion_percent) >= 100) {
      completions.set(row.module_id, (completions.get(row.module_id) ?? 0) + 1);
    }
    percentSum.set(
      row.module_id,
      (percentSum.get(row.module_id) ?? 0) + toNumber(row.completion_percent)
    );
    percentCount.set(row.module_id, (percentCount.get(row.module_id) ?? 0) + 1);
  }

  return modules.map((m) => mapModule(m, itemCount, completions, percentSum, percentCount));
}

function mapModule(
  m: ModuleRow,
  itemCount: Map<number, number>,
  completions: Map<number, number>,
  percentSum: Map<number, number>,
  percentCount: Map<number, number>
): LessonModule {
  const count = percentCount.get(m.module_id) ?? 0;
  return {
    id: m.module_id,
    title: m.module_title,
    difficulty: (m.difficulty as ModuleDifficulty) ?? 'beginner',
    language: m.language ?? 'Bisaya',
    lessons: itemCount.get(m.module_id) ?? 0,
    completions: completions.get(m.module_id) ?? 0,
    avgCompletionPercent: count ? Math.round((percentSum.get(m.module_id) ?? 0) / count) : 0,
    published: m.is_published !== 0,
    updatedAt: m.updated_at ?? m.created_at ?? new Date().toISOString(),
  };
}

function lessonPatch(data: Partial<LessonModule>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (data.title !== undefined) patch.module_title = data.title;
  if (data.difficulty !== undefined) patch.difficulty = data.difficulty;
  if (data.language !== undefined) patch.language = data.language;
  if (data.published !== undefined) patch.is_published = data.published ? 1 : 0;
  return patch;
}

export async function createLesson(data: Partial<LessonModule>): Promise<LessonModule> {
  const patch = lessonPatch(data);
  if (!patch.module_title) throw new HttpError(400, 'A module title is required.');

  const { data: inserted, error } = await svc()
    .from('learning_modules')
    .insert(patch)
    .select('module_id')
    .single();
  if (error || !inserted) throw new Error(error?.message ?? 'Could not create the module.');

  return requireLesson(inserted.module_id as number);
}

export async function updateLesson(id: number, data: Partial<LessonModule>): Promise<LessonModule> {
  const patch = lessonPatch(data);
  if (Object.keys(patch).length === 0) return requireLesson(id);

  const { error } = await svc().from('learning_modules').update(patch).eq('module_id', id);
  if (error) throw new Error(error.message);
  return requireLesson(id);
}

export async function deleteLesson(id: number): Promise<void> {
  const { error } = await svc().from('learning_modules').delete().eq('module_id', id);
  if (error) throw new Error(error.message);
}

async function requireLesson(id: number): Promise<LessonModule> {
  const lesson = (await listLessons()).find((m) => m.id === id);
  if (!lesson) throw new HttpError(404, `Module ${id} was not found.`);
  return lesson;
}

// ---------------------------------------------------------------------------
// Community
// ---------------------------------------------------------------------------

interface PostRow {
  post_id: number;
  user_id: number;
  title: string | null;
  content: string | null;
  category: string | null;
  likes_count: number | null;
  is_featured: number | null;
  is_hidden: number | null;
  created_at: string;
  users: { fullname: string } | { fullname: string }[] | null;
}

function mapPost(row: PostRow, comments: number, reports: number): CommunityPost {
  const author = one(row.users);
  return {
    id: row.post_id,
    author: { id: row.user_id, name: author?.fullname ?? 'Unknown' },
    title: row.title ?? '',
    content: row.content ?? '',
    category: row.category ?? 'general',
    likes: toNumber(row.likes_count),
    comments,
    reports,
    featured: row.is_featured === 1,
    hidden: row.is_hidden === 1,
    createdAt: row.created_at,
  };
}

export async function listPosts(): Promise<CommunityPost[]> {
  const [postsRes, commentsRes, reportsRes] = await Promise.all([
    svc()
      .from('community_posts')
      .select(
        'post_id, user_id, title, content, category, likes_count, is_featured, is_hidden, created_at, users(fullname)'
      )
      .order('created_at', { ascending: false }),
    svc().from('comments').select('post_id'),
    svc().from('community_reports').select('post_id'),
  ]);
  if (postsRes.error) throw new Error(postsRes.error.message);

  const comments = new Map<number, number>();
  for (const row of (commentsRes.data ?? []) as { post_id: number }[]) {
    comments.set(row.post_id, (comments.get(row.post_id) ?? 0) + 1);
  }
  const reports = new Map<number, number>();
  for (const row of (reportsRes.data ?? []) as { post_id: number }[]) {
    reports.set(row.post_id, (reports.get(row.post_id) ?? 0) + 1);
  }

  return ((postsRes.data ?? []) as unknown as PostRow[]).map((row) =>
    mapPost(row, comments.get(row.post_id) ?? 0, reports.get(row.post_id) ?? 0)
  );
}

async function loadPost(id: number): Promise<CommunityPost> {
  const { data, error } = await svc()
    .from('community_posts')
    .select(
      'post_id, user_id, title, content, category, likes_count, is_featured, is_hidden, created_at, users(fullname)'
    )
    .eq('post_id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(404, `Post ${id} was not found.`);

  const [comments, reports] = await Promise.all([
    countWhere('comments', 'post_id', id),
    countWhere('community_reports', 'post_id', id),
  ]);
  return mapPost(data as unknown as PostRow, comments, reports);
}

export async function toggleFeatured(id: number): Promise<CommunityPost> {
  const { data, error } = await svc()
    .from('community_posts')
    .select('is_featured')
    .eq('post_id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(404, `Post ${id} was not found.`);

  const { error: updateError } = await svc()
    .from('community_posts')
    .update({ is_featured: data.is_featured === 1 ? 0 : 1 })
    .eq('post_id', id);
  if (updateError) throw new Error(updateError.message);
  return loadPost(id);
}

export async function setPostHidden(id: number, hidden: boolean): Promise<CommunityPost> {
  const { error } = await svc()
    .from('community_posts')
    .update({ is_hidden: hidden ? 1 : 0 })
    .eq('post_id', id);
  if (error) throw new Error(error.message);
  return loadPost(id);
}

export async function deletePost(id: number): Promise<void> {
  const { error } = await svc().from('community_posts').delete().eq('post_id', id);
  if (error) throw new Error(error.message);
}

interface ReportRow {
  report_id: number;
  post_id: number;
  reporter_id: number | null;
  reason: string | null;
  status: string | null;
  created_at: string;
  users: { fullname: string } | { fullname: string }[] | null;
}

function mapReport(row: ReportRow): CommunityReport {
  const reporter = one(row.users);
  return {
    id: row.report_id,
    postId: row.post_id,
    reportedBy: { id: row.reporter_id ?? 0, name: reporter?.fullname ?? 'Unknown' },
    reason: row.reason ?? '',
    status: (row.status as ReportStatus) ?? 'open',
    createdAt: row.created_at,
  };
}

const REPORT_SELECT =
  'report_id, post_id, reporter_id, reason, status, created_at, users(fullname)';

export async function listReports(): Promise<CommunityReport[]> {
  const { data, error } = await svc()
    .from('community_reports')
    .select(REPORT_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as ReportRow[]).map(mapReport);
}

export async function updateReportStatus(
  id: number,
  status: ReportStatus
): Promise<CommunityReport> {
  if (!['open', 'resolved', 'dismissed'].includes(status)) {
    throw new HttpError(400, `Unknown report status "${status}".`);
  }
  const { error } = await svc().from('community_reports').update({ status }).eq('report_id', id);
  if (error) throw new Error(error.message);

  const { data, error: readError } = await svc()
    .from('community_reports')
    .select(REPORT_SELECT)
    .eq('report_id', id)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!data) throw new HttpError(404, `Report ${id} was not found.`);
  return mapReport(data as unknown as ReportRow);
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export async function getOverview(): Promise<OverviewResponse> {
  const days = dayKeys(7);
  const since7 = days[0].key;
  const since30 = dayKeys(30)[0].key;

  const [
    profilesRes,
    activityRes,
    progressRes,
    conversationsRes,
    speechRes,
    tutorRes,
    sessionsRes,
    totalUsers,
    reportsCount,
    conversationCount,
    speechCount,
    tutorCount,
  ] = await Promise.all([
    svc().from('learner_profiles').select('user_id, total_xp, streak'),
    svc().from('daily_activity').select('user_id, activity_date, xp_earned'),
    svc().from('learning_progress').select('completion_percent, created_at'),
    svc().from('conversations').select('created_at'),
    svc().from('speech_records').select('created_at'),
    svc().from('tutor_sessions').select('started_at'),
    svc().from('learning_sessions').select('duration_seconds'),
    countOf('users'),
    countOf('community_reports'),
    countOf('conversations'),
    countOf('speech_records'),
    countOf('tutor_sessions'),
  ]);

  const profiles = (profilesRes.data ?? []) as { total_xp: number | null; streak: number | null }[];
  const activity = (activityRes.data ?? []) as { user_id: number; activity_date: string }[];
  const progress = (progressRes.data ?? []) as {
    completion_percent: number | null;
    created_at: string;
  }[];
  const conversations = (conversationsRes.data ?? []) as { created_at: string }[];
  const speech = (speechRes.data ?? []) as { created_at: string }[];
  const tutors = (tutorRes.data ?? []) as { started_at: string }[];
  const sessions = (sessionsRes.data ?? []) as { duration_seconds: number | null }[];

  const today = dayKey(new Date());
  const distinct = (rows: { user_id: number }[]) => new Set(rows.map((r) => r.user_id));

  const activeToday = distinct(activity.filter((a) => a.activity_date === today)).size;
  const weeklyActive = distinct(activity.filter((a) => a.activity_date >= since7)).size;
  const monthlyActive = distinct(activity.filter((a) => a.activity_date >= since30)).size;

  const totalXp = profiles.reduce((sum, p) => sum + toNumber(p.total_xp), 0);
  const streakDays = profiles.reduce((max, p) => Math.max(max, toNumber(p.streak)), 0);

  const avgSessionSeconds = sessions.length
    ? sessions.reduce((sum, s) => sum + toNumber(s.duration_seconds), 0) / sessions.length
    : 0;

  const weeklyActiveTrend: SeriesPoint[] = days.map((day) => ({
    label: day.label,
    value: distinct(activity.filter((a) => a.activity_date === day.key)).size,
  }));

  const lessonsTrend: SeriesPoint[] = days.map((day) => ({
    label: day.label,
    value: progress.filter((p) => dayKey(p.created_at) === day.key).length,
  }));

  const aiTrend: SeriesPoint[] = days.map((day) => ({
    label: day.label,
    value:
      conversations.filter((c) => dayKey(c.created_at) === day.key).length +
      speech.filter((c) => dayKey(c.created_at) === day.key).length +
      tutors.filter((c) => dayKey(c.started_at) === day.key).length,
  }));

  return {
    stats: {
      totalUsers,
      activeToday,
      weeklyActive,
      monthlyActive,
      lessonsCompleted: progress.filter((p) => toNumber(p.completion_percent) >= 100).length,
      avgXpPerUser: profiles.length ? Math.round(totalXp / profiles.length) : 0,
      avgSessionMinutes: Math.round(avgSessionSeconds / 60),
      aiRequests: conversationCount + speechCount + tutorCount,
      aiFailedRequests: 0,
      communityReports: reportsCount,
      streakDays,
    },
    weeklyActive: weeklyActiveTrend,
    lessonsTrend,
    aiTrend,
  };
}

/**
 * Truthful service health.
 *
 * Every value is the result of an actual check performed right now, never a
 * static default:
 *
 *   - db   : a real round-trip through the service-role client. A failure means
 *            PostgREST or Postgres is unreachable, reported as `error`.
 *   - api  : `up` — the fact that this handler ran proves the admin API is up.
 *   - groq / whisper / storage : `unknown`. Groq and Whisper run inside
 *            Supabase Edge Functions and their keys are Edge Function secrets
 *            this app cannot introspect; Storage needs its own credentials.
 *            None can be verified from here, so they report `unknown` rather
 *            than a green `configured`. The AI Usage page shows the real
 *            request volume these providers actually serve.
 */
export async function getHealth(): Promise<SystemHealth> {
  let db: SystemHealth['db'] = 'error';
  try {
    // `avatars` is a tiny catalogue table; a counted head request is the
    // cheapest full round-trip (auth -> PostgREST -> Postgres -> response).
    const { error } = await svc()
      .from('avatars')
      .select('avatar_id', { head: true, count: 'exact' });
    db = error ? 'error' : 'connected';
  } catch {
    db = 'error';
  }

  const reachable = db === 'connected';
  return {
    // `unknown` providers are not proof of failure, so the platform is only
    // `down` when the database itself is unreachable.
    status: reachable ? 'healthy' : 'down',
    db,
    api: 'up',
    groq: 'unknown',
    whisper: 'unknown',
    storage: 'unknown',
    lastChecked: new Date().toISOString(),
  };
}

export async function getAiUsage(): Promise<AiUsageStats> {
  const days = dayKeys(7);
  const since = `${days[0].key}T00:00:00.000Z`;

  const [
    conversationsRes,
    speechRes,
    tutorRes,
    conversationCount,
    speechCount,
    tutorCount,
    voiceCount,
  ] = await Promise.all([
    svc().from('conversations').select('created_at').gte('created_at', since),
    svc().from('speech_records').select('created_at').gte('created_at', since),
    svc().from('tutor_sessions').select('started_at').gte('started_at', since),
    countOf('conversations'),
    countOf('speech_records'),
    countOf('tutor_sessions'),
    countVoiceSessions(),
  ]);

  const conversations = (conversationsRes.data ?? []) as { created_at: string }[];
  const speech = (speechRes.data ?? []) as { created_at: string }[];
  const tutors = (tutorRes.data ?? []) as { started_at: string }[];

  const trend: SeriesPoint[] = days.map((day) => ({
    label: day.label,
    value:
      conversations.filter((c) => dayKey(c.created_at) === day.key).length +
      speech.filter((c) => dayKey(c.created_at) === day.key).length +
      tutors.filter((c) => dayKey(c.started_at) === day.key).length,
  }));

  return {
    conversations: conversationCount,
    voiceRequests: voiceCount,
    whisperRequests: speechCount,
    tutorRequests: tutorCount,
    // Nothing records failures, latency or token counts yet, so these stay 0
    // rather than being estimated. Wire an `ai_usage_events` table to populate
    // them if the AI console needs real numbers.
    failedRequests: 0,
    avgResponseMs: 0,
    totalTokens: 0,
    providers: [
      { name: 'Groq · Chat', requests: conversationCount, failed: 0 },
      { name: 'Groq · Tutor', requests: tutorCount, failed: 0 },
      { name: 'Whisper · Speech', requests: speechCount, failed: 0 },
    ],
    trend,
  };
}

export async function getXpOverview(): Promise<XpOverview> {
  const days = dayKeys(7);
  const [profilesRes, activityRes, rewardsCount] = await Promise.all([
    svc().from('learner_profiles').select('total_xp, streak, users(user_id, fullname)'),
    svc()
      .from('daily_activity')
      .select('xp_earned, activity_date')
      .gte('activity_date', days[0].key),
    countOf('daily_activity'),
  ]);
  if (profilesRes.error) throw new Error(profilesRes.error.message);

  type XpProfileRow = {
    total_xp: number | null;
    streak: number | null;
    users: { user_id: number; fullname: string } | { user_id: number; fullname: string }[] | null;
  };
  const profiles = (profilesRes.data ?? []) as unknown as XpProfileRow[];
  const activity = (activityRes.data ?? []) as { xp_earned: number | null }[];

  const totalXpAwarded = profiles.reduce((sum, p) => sum + toNumber(p.total_xp), 0);
  const weeklyXp = activity.reduce((sum, a) => sum + toNumber(a.xp_earned), 0);

  const buckets = new Map<number, number>();
  for (const profile of profiles) {
    const level = levelFromXp(toNumber(profile.total_xp));
    buckets.set(level, (buckets.get(level) ?? 0) + 1);
  }
  const maxLevel = Math.max(LEVEL_THRESHOLDS.length, ...[...buckets.keys()]);
  const levelDistribution: SeriesPoint[] = [];
  for (let level = 1; level <= maxLevel; level += 1) {
    levelDistribution.push({ label: `L${level}`, value: buckets.get(level) ?? 0 });
  }

  const topUsers: TopUser[] = [...profiles]
    .sort((a, b) => toNumber(b.total_xp) - toNumber(a.total_xp))
    .slice(0, 5)
    .map((profile) => {
      const owner = one(profile.users);
      const xp = toNumber(profile.total_xp);
      return {
        id: owner?.user_id ?? 0,
        name: owner?.fullname ?? 'Unknown',
        level: levelFromXp(xp),
        xp,
        streak: toNumber(profile.streak),
      };
    });

  return {
    totalXpAwarded,
    avgDailyXp: Math.round(weeklyXp / days.length),
    dailyRewardsClaimed: rewardsCount,
    levelDistribution,
    topUsers,
  };
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

interface FeedbackRow {
  feedback_id: number;
  functionality: number | null;
  usability: number | null;
  reliability: number | null;
  comment: string | null;
  resolved: number | null;
  created_at: string;
  users:
    | { user_id: number; fullname: string; email: string }
    | { user_id: number; fullname: string; email: string }[]
    | null;
}

const FEEDBACK_SELECT =
  'feedback_id, functionality, usability, reliability, comment, resolved, created_at, users(user_id, fullname, email)';

function mapFeedback(row: FeedbackRow): FeedbackItem {
  const user = one(row.users);
  return {
    id: row.feedback_id,
    user: { id: user?.user_id ?? 0, name: user?.fullname ?? 'Unknown', email: user?.email ?? '' },
    functionality: toNumber(row.functionality),
    usability: toNumber(row.usability),
    reliability: toNumber(row.reliability),
    comment: row.comment ?? undefined,
    resolved: row.resolved === 1,
    createdAt: row.created_at,
  };
}

export async function listFeedback(): Promise<FeedbackItem[]> {
  const { data, error } = await svc()
    .from('feedback')
    .select(FEEDBACK_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as FeedbackRow[]).map(mapFeedback);
}

export async function resolveFeedback(id: number): Promise<FeedbackItem> {
  const { data, error } = await svc()
    .from('feedback')
    .select('resolved')
    .eq('feedback_id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(404, `Feedback ${id} was not found.`);

  const { error: updateError } = await svc()
    .from('feedback')
    .update({ resolved: data.resolved === 1 ? 0 : 1 })
    .eq('feedback_id', id);
  if (updateError) throw new Error(updateError.message);

  const { data: row, error: readError } = await svc()
    .from('feedback')
    .select(FEEDBACK_SELECT)
    .eq('feedback_id', id)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!row) throw new HttpError(404, `Feedback ${id} was not found.`);
  return mapFeedback(row as unknown as FeedbackRow);
}

// ---------------------------------------------------------------------------
// Preservation
// ---------------------------------------------------------------------------

interface PreservedRow {
  word_id: number;
  word: string;
  definition: string | null;
  dialectal_region: string | null;
  variations: string[] | null;
  submitted_by: number | null;
  status: string | null;
  created_at: string;
  users: { fullname: string } | { fullname: string }[] | null;
}

const PRESERVED_SELECT =
  'word_id, word, definition, dialectal_region, variations, submitted_by, status, created_at, users(fullname)';

function mapPreserved(row: PreservedRow): PreservedWord {
  const submitter = one(row.users);
  return {
    id: row.word_id,
    word: row.word,
    dialect: row.dialectal_region ?? 'Unknown',
    meaning: row.definition ?? '',
    submittedBy: { id: row.submitted_by ?? 0, name: submitter?.fullname ?? 'Unknown' },
    status: (row.status as VerificationStatus) ?? 'pending',
    variations: Array.isArray(row.variations) ? row.variations : [],
    createdAt: row.created_at,
  };
}

export async function listPreserved(): Promise<PreservedWord[]> {
  const { data, error } = await svc()
    .from('preserved_words')
    .select(PRESERVED_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as PreservedRow[]).map(mapPreserved);
}

export async function verifyPreserved(
  id: number,
  status: VerificationStatus
): Promise<PreservedWord> {
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    throw new HttpError(400, `Unknown verification status "${status}".`);
  }
  const { error } = await svc().from('preserved_words').update({ status }).eq('word_id', id);
  if (error) throw new Error(error.message);

  const { data, error: readError } = await svc()
    .from('preserved_words')
    .select(PRESERVED_SELECT)
    .eq('word_id', id)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!data) throw new HttpError(404, `Word ${id} was not found.`);
  return mapPreserved(data as unknown as PreservedRow);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'admin';

const DEFAULT_SETTINGS: Omit<AdminSettings, 'admins' | 'updatedAt'> = {
  maintenanceMode: false,
  allowSignups: true,
  allowCommunity: true,
  requireVerificationForCommunity: false,
  dailyXpGoal: 50,
  maxDailyAiRequests: 100,
  aiProvider: 'auto',
};

async function listAdmins(): Promise<AdminSettings['admins']> {
  const { data, error } = await svc()
    .from('users')
    .select('user_id, fullname, email, role')
    .in('role', ['admin', 'moderator'])
    .order('fullname', { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { user_id: number; fullname: string; email: string; role: string }[]).map(
    (row) => ({
      id: row.user_id,
      name: row.fullname,
      email: row.email,
      role: row.role as UserRole,
    })
  );
}

export async function getSettings(): Promise<AdminSettings> {
  const [row, admins] = await Promise.all([
    svc()
      .from('platform_settings')
      .select('value, updated_at')
      .eq('key', SETTINGS_KEY)
      .maybeSingle(),
    listAdmins(),
  ]);
  if (row.error) throw new Error(row.error.message);

  const value = (row.data?.value ?? {}) as Partial<AdminSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    admins,
    updatedAt: (row.data?.updated_at as string) ?? new Date().toISOString(),
  };
}

export async function updateSettings(patch: Partial<AdminSettings>): Promise<AdminSettings> {
  const current = await svc()
    .from('platform_settings')
    .select('value')
    .eq('key', SETTINGS_KEY)
    .maybeSingle();
  if (current.error) throw new Error(current.error.message);

  const existing = (current.data?.value ?? {}) as Record<string, unknown>;
  const safePatch: Record<string, unknown> = { ...patch };
  // `admins` and `updatedAt` are derived, never persisted as operator input.
  delete safePatch.admins;
  delete safePatch.updatedAt;
  const merged = { ...existing, ...safePatch };

  const { error } = await svc()
    .from('platform_settings')
    .upsert(
      { key: SETTINGS_KEY, value: merged, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  if (error) throw new Error(error.message);

  return getSettings();
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

interface AuditLogRow {
  id: number;
  user_id: number | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: string | null;
  timestamp: string;
}

/** Resolves actor display names in one round-trip, never per row. */
async function fetchAuditActors(
  ids: number[]
): Promise<Map<number, { id: number; name: string; email: string }>> {
  const map = new Map<number, { id: number; name: string; email: string }>();
  if (ids.length === 0) return map;
  const { data, error } = await svc()
    .from('users')
    .select('user_id, fullname, email')
    .in('user_id', ids);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as {
    user_id: number;
    fullname: string | null;
    email: string | null;
  }[]) {
    map.set(row.user_id, { id: row.user_id, name: row.fullname ?? '', email: row.email ?? '' });
  }
  return map;
}

export async function listAuditLogs(query: AuditLogFilters & {
  page: number;
  perPage: number;
}): Promise<AuditLogResponse> {
  const page = Math.max(1, Math.floor(query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Math.floor(query.perPage) || 20));
  const from = (page - 1) * perPage;

  let q = svc().from('audit_logs').select(
    'id, user_id, action, resource_type, resource_id, details, timestamp',
    { count: 'exact' }
  );

  if (query.resourceType && query.resourceType !== 'all') {
    q = q.eq('resource_type', query.resourceType);
  }
  if (query.actorId && query.actorId !== 'all') {
    q = q.eq('user_id', query.actorId);
  }
  if (query.search) {
    const term = query.search.replace(/[%_,]/g, '');
    if (term) q = q.or(`action.ilike.%${term}%,details.ilike.%${term}%`);
  }

  const { data, error, count } = await q
    .order('timestamp', { ascending: false })
    .range(from, from + perPage - 1);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as AuditLogRow[];
  const actorIds = [
    ...new Set(rows.map((r) => r.user_id).filter((v): v is number => typeof v === 'number')),
  ];
  const actors = await fetchAuditActors(actorIds);

  const items: AuditLog[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    details: r.details,
    timestamp: r.timestamp,
    actor: r.user_id != null ? actors.get(r.user_id) ?? null : null,
  }));

  return { items, total: count ?? items.length, page, perPage };
}
