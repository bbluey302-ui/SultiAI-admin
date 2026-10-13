export type SystemStatus = 'healthy' | 'degraded' | 'down';

export type UserRole = 'user' | 'admin' | 'moderator';

export type UserStatus = 'pending' | 'approved' | 'rejected' | 'banned' | 'suspended' | 'active';

export type ModuleDifficulty = 'beginner' | 'intermediate' | 'advanced';

export type ReportStatus = 'open' | 'resolved' | 'dismissed';

export type VerificationStatus = 'pending' | 'approved' | 'rejected';

export interface AdminSession {
  id: string;
  name: string;
  email: string;
  provider: 'google' | 'email';
  role: UserRole;
  avatar: string;
  signedInAt: string;
}

export interface OverviewStats {
  totalUsers: number;
  activeToday: number;
  weeklyActive: number;
  monthlyActive: number;
  lessonsCompleted: number;
  avgXpPerUser: number;
  avgSessionMinutes: number;
  aiRequests: number;
  aiFailedRequests: number;
  communityReports: number;
  streakDays: number;
}

export interface SystemHealth {
  status: SystemStatus;
  db: 'connected' | 'error';
  api: 'up' | 'down';
  /**
   * Groq/Whisper run inside Supabase Edge Functions; their API keys are Edge
   * Function secrets this app cannot introspect, and Storage needs its own
   * credentials. None can be verified from here, so they report `unknown`
   * rather than a green `configured`. Only a real request/health probe flips
   * them to `configured`/`error`.
   */
  groq: 'configured' | 'not_set' | 'error' | 'unknown';
  whisper: 'configured' | 'not_set' | 'error' | 'unknown';
  storage: 'up' | 'down' | 'unknown';
  lastChecked: string;
}

export interface SeriesPoint {
  label: string;
  value: number;
}

export interface DailyActivityPoint {
  date: string;
  active: number;
  lessons: number;
  ai: number;
}

export interface OverviewResponse {
  stats: OverviewStats;
  weeklyActive: SeriesPoint[];
  lessonsTrend: SeriesPoint[];
  aiTrend: SeriesPoint[];
}

export interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  level: number;
  xp: number;
  streak: number;
  lessons: number;
  verified: boolean;
  nativeSpeaker: boolean;
  joinedAt: string;
  lastActive: string;
  country?: string;
  authProvider?: string;
}

export interface UserListResponse {
  items: AdminUser[];
  total: number;
  page: number;
  perPage: number;
}

export interface UserDetail extends AdminUser {
  badges: string[];
  weakAreas: string[];
  favoriteCategory: string;
  totalCoins: number;
  dailyGoal: number;
  feedbackCount: number;
}

export interface UserFilters {
  search: string;
  role: UserRole | 'all';
  status: UserStatus | 'all';
  sort: 'xp' | 'level' | 'recent' | 'joined';
}

export interface LessonModule {
  id: number;
  title: string;
  difficulty: ModuleDifficulty;
  language: string;
  lessons: number;
  completions: number;
  avgCompletionPercent: number;
  published: boolean;
  updatedAt: string;
}

export interface CommunityPost {
  id: number;
  author: { id: number; name: string };
  title: string;
  content: string;
  category: string;
  likes: number;
  comments: number;
  reports: number;
  featured: boolean;
  hidden: boolean;
  createdAt: string;
}

export interface CommunityReport {
  id: number;
  postId: number;
  reportedBy: { id: number; name: string };
  reason: string;
  status: ReportStatus;
  createdAt: string;
}

export interface AiUsageStats {
  conversations: number;
  voiceRequests: number;
  whisperRequests: number;
  tutorRequests: number;
  failedRequests: number;
  avgResponseMs: number;
  totalTokens: number;
  providers: { name: string; requests: number; failed: number }[];
  trend: SeriesPoint[];
}

export interface XpOverview {
  totalXpAwarded: number;
  avgDailyXp: number;
  dailyRewardsClaimed: number;
  levelDistribution: SeriesPoint[];
  topUsers: TopUser[];
}

export interface TopUser {
  id: number;
  name: string;
  level: number;
  xp: number;
  streak: number;
}

export interface FeedbackItem {
  id: number;
  user: { id: number; name: string; email: string };
  functionality: number;
  usability: number;
  reliability: number;
  comment?: string;
  resolved: boolean;
  createdAt: string;
}

export interface PreservedWord {
  id: number;
  word: string;
  dialect: string;
  meaning: string;
  submittedBy: { id: number; name: string };
  status: VerificationStatus;
  variations: string[];
  createdAt: string;
}

export interface AdminSettings {
  maintenanceMode: boolean;
  allowSignups: boolean;
  allowCommunity: boolean;
  requireVerificationForCommunity: boolean;
  dailyXpGoal: number;
  maxDailyAiRequests: number;
  aiProvider: 'groq' | 'openai' | 'auto';
  admins: { id: number; name: string; email: string; role: UserRole }[];
  updatedAt: string;
}

/** A raw `public.users` row, as rendered by the live DB monitor. */
export interface MonitoredUser {
  user_id: number;
  fullname: string;
  username: string | null;
  email: string;
  clerk_id: string | null;
  google_id: string | null;
  supabase_id: string | null;
  avatar_id: number | null;
  preferred_lang: string | null;
  learning_lang: string | null;
  country: string | null;
  role: string;
  is_verified: number;
  is_native_speaker: number;
  bio: string | null;
  created_at: string;
}

export interface UserStats {
  total: number;
  verified: number;
  nativeSpeakers: number;
  admins: number;
  newLast7Days: number;
  latestSignup: string | null;
}

export interface MonitorSnapshot {
  ok: true;
  fetchedAt: string;
  stats: UserStats;
  users: MonitoredUser[];
}

export interface AuditLog {
  id: number;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: string | null;
  timestamp: string;
  actor: { id: number; name: string; email: string } | null;
}

export interface AuditLogResponse {
  items: AuditLog[];
  total: number;
  page: number;
  perPage: number;
}

export interface AuditLogFilters {
  search: string;
  resourceType: string;
  actorId: number | 'all';
}
