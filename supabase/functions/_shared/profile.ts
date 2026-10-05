// Replaces `contextManager.buildContext()` from the Express server.
//
// The original walked drizzle repositories (learners, tutor sessions,
// preservation, conversation memory) and Mongo. Almost all of that was DB work
// the app can now do directly through the Supabase client under RLS, so this
// helper only does the one thing the prompts genuinely need: the learner's
// current level, injected as a hint.
//
// `supabase` here is the RLS-scoped client from `withSupabase({ auth: 'user' })`,
// so the "Users can view own profile" policy on learner_profiles already
// restricts this to the caller's own row — no user_id filter is needed or safe
// to add, because the client does not know its integer PK.

export interface ProfileHint {
  level: string;
  totalXp: number;
  coins: number;
  streak: number;
  dailyXp: number;
  dailyGoal: number;
  totalSessions: number;
  lastActive: string | null;
  strengths: string[];
  weakAreas: string[];
  commonMistakes: string[];
}

const DEFAULTS: ProfileHint = {
  level: 'beginner',
  totalXp: 0,
  coins: 0,
  streak: 0,
  dailyXp: 0,
  dailyGoal: 50,
  totalSessions: 0,
  lastActive: null,
  strengths: [],
  weakAreas: [],
  commonMistakes: [],
};

// The server stored these as comma-joined strings in a TEXT column.
function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export async function loadProfile(supabase: any): Promise<ProfileHint> {
  try {
    const { data, error } = await supabase
      .from('learner_profiles')
      .select(
        'level,total_xp,coins,streak,daily_xp,daily_goal,total_sessions,last_active,strengths,weak_areas,common_mistakes'
      )
      .maybeSingle();

    if (error || !data) return DEFAULTS;

    return {
      level: data.level || DEFAULTS.level,
      totalXp: Number(data.total_xp ?? 0),
      coins: Number(data.coins ?? 0),
      streak: Number(data.streak ?? 0),
      dailyXp: Number(data.daily_xp ?? 0),
      dailyGoal: Number(data.daily_goal ?? DEFAULTS.dailyGoal),
      totalSessions: Number(data.total_sessions ?? 0),
      lastActive: data.last_active ?? null,
      strengths: splitList(data.strengths),
      weakAreas: splitList(data.weak_areas),
      commonMistakes: splitList(data.common_mistakes),
    };
  } catch {
    // A missing profile must never break a tutor reply; the prompts simply lose
    // the level hint, which they are written to tolerate.
    return DEFAULTS;
  }
}

/** The one-line level hint the Express code appended to every system prompt. */
export function levelHint(profile: ProfileHint): string {
  return `The learner is currently at the ${profile.level} level.`;
}
