-- SultiAI: auth provisioning for a serverless (no Express backend) architecture.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- Until now, the Express server in `server/` owned the link between a Supabase
-- Auth identity and a row in `public.users`:
--
--     POST /api/auth/sync-supabase      (called on every onAuthStateChange)
--     POST /api/auth/confirm-user       (called on signup)
--
-- Both endpoints are removed in the serverless build. But every RLS policy in
-- 20260904_fix_rls_policies.sql resolves ownership through `get_user_id()`,
-- which is defined as:
--
--     SELECT user_id FROM public.users WHERE supabase_id = auth.uid()::text
--
-- So without a `public.users` row, `get_user_id()` returns NULL and every
-- ownership policy fails closed: the user authenticates successfully but can
-- read or write nothing. This migration moves that provisioning into Postgres
-- itself, so the row exists the instant the auth user is created.
--
-- It also seeds the per-user rows the app expects to always exist
-- (settings, learner profile) so the client never has to lazily create them.

-- ============================================
-- 0. Backfill: adopt any existing auth users
-- ============================================
-- Apps signed up while the Express server was running may have an auth.users
-- row with no matching public.users row. Adopt them before installing the
-- trigger so no one is locked out of their own data.
INSERT INTO public.users (fullname, email, password_hash, supabase_id, role, preferred_lang, learning_lang)
SELECT
  COALESCE(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'fullname', split_part(au.email, '@', 1)),
  au.email,
  'supabase-managed',
  au.id::text,
  COALESCE(au.raw_user_meta_data ->> 'role', 'user'),
  COALESCE(au.raw_user_meta_data ->> 'native_language', 'English'),
  COALESCE(au.raw_user_meta_data ->> 'target_language', 'Bisaya')
FROM auth.users au
WHERE au.email IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.supabase_id = au.id::text)
ON CONFLICT (supabase_id) DO NOTHING;

-- ============================================
-- 1. Provision on signup
-- ============================================
-- SECURITY DEFINER so the insert runs as the function owner and bypasses RLS.
-- Without this, a brand-new auth user would be unable to insert its own row
-- (the "Users can view own profile" policy only grants SELECT/UPDATE, not
-- INSERT), and every subsequent read would fail closed.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id      INTEGER;
  v_fullname     TEXT;
  v_native_lang  TEXT;
  v_target_lang  TEXT;
  v_country      TEXT;
BEGIN
  v_fullname    := COALESCE(
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'fullname',
    split_part(COALESCE(NEW.email, ''), '@', 1),
    'Learner'
  );
  v_native_lang := COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'native_language', ''), 'English');
  v_target_lang := COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'target_language', ''), 'Bisaya');
  v_country     := COALESCE(NEW.raw_user_meta_data ->> 'country', '');

  -- Re-running on an existing identity (e.g. re-linking Google to an email that
  -- already has a row) must adopt that row instead of creating a duplicate.
  INSERT INTO public.users (fullname, email, password_hash, supabase_id, role, preferred_lang, learning_lang, country)
  VALUES (v_fullname, NEW.email, 'supabase-managed', NEW.id::text,
          COALESCE(NEW.raw_user_meta_data ->> 'role', 'user'),
          v_native_lang, v_target_lang, v_country)
  ON CONFLICT (supabase_id) DO UPDATE
    SET fullname      = COALESCE(NULLIF(EXCLUDED.fullname, ''), public.users.fullname),
        preferred_lang = COALESCE(NULLIF(EXCLUDED.preferred_lang, ''), public.users.preferred_lang),
        learning_lang  = COALESCE(NULLIF(EXCLUDED.learning_lang, ''), public.users.learning_lang),
        country        = COALESCE(NULLIF(EXCLUDED.country, ''), public.users.country)
  RETURNING user_id INTO v_user_id;

  -- user_settings: one row per user (UNIQUE on user_id). ON CONFLICT DO NOTHING
  -- keeps this idempotent if the trigger is ever re-fired.
  INSERT INTO public.user_settings (user_id, dark_mode, speech_speed, voice_gender)
  VALUES (v_user_id, 0, 1.0, 'neutral')
  ON CONFLICT (user_id) DO NOTHING;

  -- learner_profiles: holds level / xp / coins / streak for the gamification UI.
  INSERT INTO public.learner_profiles (user_id, level, total_xp, coins, streak, daily_xp, daily_goal, total_sessions)
  VALUES (v_user_id, 'beginner', 0, 0, 0, 0, 50, 0)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- The trigger lives on auth.users, which the client role cannot write to, so
-- this is the only path that creates rows.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ============================================
-- 2. Repair users that predate this trigger
-- ============================================
-- Backfill the two dependent tables for auth users adopted in section 0.
INSERT INTO public.user_settings (user_id, dark_mode, speech_speed, voice_gender)
SELECT u.user_id, 0, 1.0, 'neutral'
FROM public.users u
JOIN auth.users au ON au.id::text = u.supabase_id
WHERE NOT EXISTS (SELECT 1 FROM public.user_settings s WHERE s.user_id = u.user_id);

INSERT INTO public.learner_profiles (user_id, level, total_xp, coins, streak, daily_xp, daily_goal, total_sessions)
SELECT u.user_id, 'beginner', 0, 0, 0, 0, 50, 0
FROM public.users u
JOIN auth.users au ON au.id::text = u.supabase_id
WHERE NOT EXISTS (SELECT 1 FROM public.learner_profiles p WHERE p.user_id = u.user_id);

-- ============================================
-- 3. Keep the profile in sync when a user edits onboarding
-- ============================================
-- OnboardingForm calls api.updateProfile(...) to persist native/target language.
-- The trigger only fires on INSERT, so mirror metadata edits to the public row
-- instead of trusting the client to remember to call a second endpoint.
CREATE OR REPLACE FUNCTION public.handle_auth_user_metadata_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.users u
  SET
    fullname       = COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''), u.fullname),
    preferred_lang = COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'native_language', ''), u.preferred_lang),
    learning_lang  = COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'target_language', ''), u.learning_lang),
    country        = COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'country', ''), u.country)
  WHERE u.supabase_id = NEW.id::text;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW
  WHEN (OLD.raw_user_meta_data IS DISTINCT FROM NEW.raw_user_meta_data)
  EXECUTE FUNCTION public.handle_auth_user_metadata_update();

-- ============================================
-- 4. Let the client read its own profile row without a lookup helper
-- ============================================
-- The app calls supabase.from('users').select(...).eq('supabase_id', user.id)
-- as its very first request on launch. The existing policy only covers
-- SELECT/UPDATE on the owner's own row, which is exactly that query, so this
-- is a no-op safety net in case the policy was ever dropped.
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING (supabase_id = auth.uid()::text OR is_admin());

-- ============================================
-- 5. Leaderboard needs a cross-user read that RLS currently forbids
-- ============================================
-- GET /api/game/leaderboard aggregated learner_profiles across all users. With
-- no server, the client queries directly, so expose a narrow view rather than
-- relaxing learner_profiles wholesale (which would leak per-user learning data).
--
-- NOTE ON security_invoker
-- ----------------------
-- This view must NOT be created `WITH (security_invoker = true)`. That option
-- makes the query run with the *caller's* privileges, so RLS on `users` and
-- `learner_profiles` would still apply and every caller would see exactly one
-- row - their own. Postgres 15+ defaults to the definer's privileges, which is
-- what a cross-user read requires, so the option is simply omitted.
--
-- The view is deliberately narrow: display name, avatar, XP, streak, level and
-- last-active. No email, no native language, no learning history.
DROP VIEW IF EXISTS public.leaderboard;
CREATE VIEW public.leaderboard AS
SELECT
  p.user_id,
  u.supabase_id,
  u.fullname,
  a.avatar_image,
  p.total_xp,
  p.streak,
  p.level,
  p.last_active
FROM public.learner_profiles p
JOIN public.users u ON u.user_id = p.user_id
LEFT JOIN public.avatars a ON a.avatar_id = u.avatar_id
WHERE p.total_xp > 0;

GRANT SELECT ON public.leaderboard TO anon, authenticated;

-- Ordering the leaderboard needs an index on the same expression it sorts by.
CREATE INDEX IF NOT EXISTS idx_learner_profiles_total_xp
  ON public.learner_profiles (total_xp DESC)
  WHERE total_xp > 0;

-- ============================================
-- 6. Community feed needs author names across users
-- ============================================
-- The same problem, same fix. `users` RLS exposes only the caller's own row, so
-- neither a PostgREST embed (`users(fullname)`) nor a client-side join can
-- resolve who wrote somebody else's post or comment - it would silently come
-- back null and render every author as "Anonymous".
--
-- These two views are the whole of the app's cross-user read surface, and both
-- project exactly the fields the mobile client renders. community_posts and
-- comments already have public SELECT policies, so only the users join needed
-- bypassing.
DROP VIEW IF EXISTS public.post_feed;
CREATE VIEW public.post_feed AS
SELECT
  p.post_id                AS id,
  p.user_id,
  p.category               AS type,
  p.title,
  p.content,
  p.phrase                 AS native,
  p.translation            AS english,
  u.fullname               AS author_name,
  COALESCE(v.verified, false) AS author_verified,
  COALESCE(u.is_native_speaker, false) AS is_native,
  p.created_at,
  p.likes_count            AS likes,
  COALESCE(cc.comment_count, 0) AS comments,
  a.avatar_image           AS author_avatar
FROM public.community_posts p
JOIN public.users u ON u.user_id = p.user_id
LEFT JOIN public.avatars a ON a.avatar_id = u.avatar_id
-- Aggregated, not a plain join: `verifications` has no unique constraint on
-- user_id, so a direct join would duplicate a post once per approved request.
LEFT JOIN LATERAL (
  SELECT BOOL_OR(vr.status = 'approved') AS verified
  FROM public.verifications vr
  WHERE vr.user_id = p.user_id
) v ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS comment_count
  FROM public.comments c
  WHERE c.post_id = p.post_id
) cc ON TRUE;

DROP VIEW IF EXISTS public.comment_feed;
CREATE VIEW public.comment_feed AS
SELECT
  c.comment_id AS id,
  c.comment_id,
  c.post_id,
  c.user_id,
  u.fullname   AS author_name,
  a.avatar_image AS author_avatar,
  c.comment,
  c.created_at
FROM public.comments c
JOIN public.users u ON u.user_id = c.user_id
LEFT JOIN public.avatars a ON a.avatar_id = u.avatar_id;

GRANT SELECT ON public.post_feed, public.comment_feed TO anon, authenticated;

-- PostgREST needs to know these views are in the schema cache; a reload of the
-- schema is what makes them queryable over HTTP without a server restart.
NOTIFY pgrst, 'reload schema';

-- ============================================
-- 7. Client writes that had no INSERT policy
-- ============================================
-- 20260904_fix_rls_policies.sql only granted INSERT where the Express server
-- performed the write. Four flows are now client-side and need their own
-- policy, or they fail with a bare "new row violates row-level security" that
-- no screen can explain to a user.

-- XP credits: `awardXp` in src/services/api.js writes the xp_logs row that makes
-- a reward idempotent. Without this, daily rewards and challenges cannot pay.
DROP POLICY IF EXISTS "Users can log own XP" ON public.xp_logs;
CREATE POLICY "Users can log own XP" ON public.xp_logs
  FOR INSERT WITH CHECK (user_id = get_user_id());

-- Achievements and badges are unlocked locally by GameContext and mirrored to
-- the DB so they survive a reinstall.
DROP POLICY IF EXISTS "Users can unlock own achievements" ON public.user_achievements;
CREATE POLICY "Users can unlock own achievements" ON public.user_achievements
  FOR INSERT WITH CHECK (user_id = get_user_id());

DROP POLICY IF EXISTS "Users can unlock own badges" ON public.user_badges;
CREATE POLICY "Users can unlock own badges" ON public.user_badges
  FOR INSERT WITH CHECK (user_id = get_user_id());

-- `api.checkAchievements` mirrors locally-earned achievements with an
-- INSERT ... ON CONFLICT DO NOTHING, and PostgREST's `on_conflict` needs a
-- uniquely indexed column list by name. The table already carries
-- UNIQUE(user_id, achievement_id), but only as an auto-generated constraint
-- name, so an explicitly named equivalent is added here and used instead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_achievements_user_achievement
  ON public.user_achievements (user_id, achievement_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_badges_user_badge
  ON public.user_badges (user_id, badge_id);
