-- ============================================================================
-- SultiAI - bring the LIVE Supabase project up to the repo schema.
--
-- WHY: this project was originally provisioned by the retired Express server, so
-- `supabase_migrations` history does not exist remotely and several of the
-- repo's migrations were never applied. The live DB is missing:
--   * public.users.status                       (used by the admin console)
--   * RLS policies + helper functions (is_admin, get_user_id, ...): user tables
--     have RLS enabled with no policy, so the app boots and then reads nothing.
--   * lesson_items and learning_sessions tables
--   * leaderboard / post_feed / comment_feed views
--   * admin-console columns (community_posts.is_hidden, feedback.comment,
--     learning_modules.is_published/updated_at, preserved_words.variations)
--
-- HOW TO RUN: paste this whole file into the Supabase SQL Editor and Run.
-- Every statement is IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS, so
-- it is safe to run more than once.
--
-- NOTE: the base migration 20260827073100_new-migration.sql is intentionally not
-- replayed (its tables already exist). The only base column this project is
-- missing - users.status - is added in the PREAMBLE below.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PREAMBLE
-- ---------------------------------------------------------------------------
-- 1. The base-schema column the live project never got.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';

CREATE INDEX IF NOT EXISTS idx_users_status ON public.users(status);

-- Make sure RLS is on for the table the app reads first. Enabling it twice is a
-- no-op, and leaving it off would expose every profile to the anon key.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- 2. 20260904_add_rbac_tables.sql creates these three policies with USING(true)
--    and has already run once, so drop them or its CREATE POLICY would collide.
--    20260904_fix_rls_policies.sql drops them again right after (qual = 'true');
--    20261007120000 recreates them with the admin check they always claimed.
DROP POLICY IF EXISTS "Admins can manage roles" ON public.roles;
DROP POLICY IF EXISTS "Admins can manage permissions" ON public.permissions;
DROP POLICY IF EXISTS "Admins can manage role permissions" ON public.role_permissions;

-- 2b. Policy idempotency: every policy this script (re)creates is
--     dropped first, so the whole file is safe to run more than once (the
--     original fix_rls migration used bare CREATE POLICY). Tables created
--     later in this file may not exist yet, so each drop is guarded by a
--     to_regclass() check.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.ai_recommendations','Admins can view all recommendations'),
      ('public.ai_recommendations','Users can manage own recommendations'),
      ('public.audit_logs','Admins can view all audit logs'),
      ('public.audit_logs','Service role and admins can insert audit logs'),
      ('public.audit_logs','System can insert audit logs'),
      ('public.avatars','Admins can manage avatars'),
      ('public.avatars','Anyone can view avatars'),
      ('public.bookmarks','Admins can view all bookmarks'),
      ('public.bookmarks','Users can manage own bookmarks'),
      ('public.comments','Admins can manage all comments'),
      ('public.comments','Anyone can view comments'),
      ('public.comments','Moderators can delete comments'),
      ('public.comments','Users can create comments'),
      ('public.comments','Users can delete own comments'),
      ('public.comments','Users can update own comments'),
      ('public.community_posts','Admins can manage all posts'),
      ('public.community_posts','Anyone can view published posts'),
      ('public.community_posts','Moderators can delete posts'),
      ('public.community_posts','Moderators can moderate posts'),
      ('public.community_posts','Users can create posts'),
      ('public.community_posts','Users can delete own posts'),
      ('public.community_posts','Users can update own posts'),
      ('public.community_reports','Admins can manage all reports'),
      ('public.community_reports','Moderators can update reports'),
      ('public.community_reports','Moderators can view and update reports'),
      ('public.community_reports','Users can create reports'),
      ('public.community_reports','Users can view own reports'),
      ('public.completed_challenges','Admins can view all challenges'),
      ('public.completed_challenges','Users can manage own challenges'),
      ('public.completed_challenges','Users can view own challenges'),
      ('public.conversation_messages','Admins can view all messages'),
      ('public.conversation_messages','Users can manage own messages'),
      ('public.conversation_summaries','Admins can view all summaries'),
      ('public.conversation_summaries','Users can manage own summaries'),
      ('public.conversations','Admins can view all conversations'),
      ('public.conversations','Users can manage own conversations'),
      ('public.daily_activity','Admins can view all activity'),
      ('public.daily_activity','Users can manage own activity'),
      ('public.daily_activity','Users can view own activity'),
      ('public.feedback','Admins can manage all feedback'),
      ('public.feedback','Users can create feedback'),
      ('public.feedback','Users can view own feedback'),
      ('public.follows','Admins can view all follows'),
      ('public.follows','Users can manage own follows'),
      ('public.follows','Users can view own followers'),
      ('public.learner_profiles','Admins can view all profiles'),
      ('public.learner_profiles','Users can update own profile'),
      ('public.learner_profiles','Users can view own profile'),
      ('public.learning_analytics','Admins can view all analytics'),
      ('public.learning_analytics','Users can view own analytics'),
      ('public.learning_modules','Admins can manage modules'),
      ('public.learning_modules','Anyone can view modules'),
      ('public.learning_progress','Admins can view all progress'),
      ('public.learning_progress','Users can manage own progress'),
      ('public.learning_progress','Users can view own progress'),
      ('public.learning_sessions','Users manage own learning sessions'),
      ('public.lesson_items','Admins can manage lesson items'),
      ('public.lesson_items','Anyone can view lesson items'),
      ('public.lesson_items','Authenticated users can view lesson items'),
      ('public.likes','Admins can view all likes'),
      ('public.likes','Users can manage own likes'),
      ('public.notification_preferences','Admins can view all preferences'),
      ('public.notification_preferences','Users can manage own preferences'),
      ('public.notifications','Admins can view all notifications'),
      ('public.notifications','Users can manage own notifications'),
      ('public.notifications','Users can view own notifications'),
      ('public.permissions','Admins can manage permissions'),
      ('public.phrase_recommendations','Admins can view all recommendations'),
      ('public.phrase_recommendations','Users can view own recommendations'),
      ('public.platform_settings','Admins can manage platform settings'),
      ('public.platform_settings','Authenticated users can read platform settings'),
      ('public.preserved_words','Admins can manage all words'),
      ('public.preserved_words','Anyone can view approved words'),
      ('public.preserved_words','Moderators can verify words'),
      ('public.preserved_words','Users can submit words'),
      ('public.pronunciation_attempts','Admins can view all attempts'),
      ('public.pronunciation_attempts','Users can manage own attempts'),
      ('public.role_permissions','Admins can manage role permissions'),
      ('public.roles','Admins can manage roles'),
      ('public.saved_phrases','Admins can view all phrases'),
      ('public.saved_phrases','Users can manage own phrases'),
      ('public.speech_records','Admins can view all speech'),
      ('public.speech_records','Users can manage own speech'),
      ('public.translations','Admins can view all translations'),
      ('public.translations','Users can view own translations'),
      ('public.tutor_sessions','Admins can view all sessions'),
      ('public.tutor_sessions','Users can manage own sessions'),
      ('public.user_achievements','Admins can manage all achievements'),
      ('public.user_achievements','Users can unlock own achievements'),
      ('public.user_achievements','Users can view own achievements'),
      ('public.user_badges','Admins can manage all badges'),
      ('public.user_badges','Users can unlock own badges'),
      ('public.user_badges','Users can view own badges'),
      ('public.user_sessions','Admins can view all sessions'),
      ('public.user_sessions','Users can manage own sessions'),
      ('public.user_settings','Admins can view all settings'),
      ('public.user_settings','Users can update own settings'),
      ('public.user_settings','Users can view own settings'),
      ('public.users','Admins can manage all users'),
      ('public.users','Admins can view all users'),
      ('public.users','Moderators can view all users'),
      ('public.users','Users can update own profile'),
      ('public.users','Users can view own profile'),
      ('public.verification_requests','Admins can manage all requests'),
      ('public.verification_requests','Moderators can approve requests'),
      ('public.verification_requests','Moderators can view and approve requests'),
      ('public.verification_requests','Users can create requests'),
      ('public.verification_requests','Users can view own requests'),
      ('public.verifications','Admins can manage all verifications'),
      ('public.verifications','Moderators can verify submissions'),
      ('public.verifications','Users can create verifications'),
      ('public.verifications','Users can view own verifications'),
      ('public.vocabulary_reviews','Admins can view all vocabulary'),
      ('public.vocabulary_reviews','Users can manage own vocabulary'),
      ('public.xp_logs','Admins can view all XP'),
      ('public.xp_logs','Users can log own XP'),
      ('public.xp_logs','Users can view own XP'),
      ('storage.objects','Moderators read all verification audio'),
      ('storage.objects','Users read own verification audio'),
      ('storage.objects','Users upload own verification audio')
    ) AS v(tbl, pol)
  LOOP
    IF to_regclass(r.tbl) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %s', r.pol, r.tbl);
    END IF;
  END LOOP;
END $$;

-- 3. The base migration 20260827073100_new-migration.sql is not replayed (its
--    tables already exist), but the live project never received its timestamp
--    helper. 20261013120000_admin_console_supabase.sql installs a trigger that
--    calls it, so define the function (and the base triggers whose tables carry
--    an `updated_at` column) here.
--    NOTE: the base migration also defines update_user_settings_updated_at on
--    public.user_settings, but that table has NO updated_at column, so that
--    trigger is intentionally omitted - it would break every user_settings UPDATE.
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_vocabulary_reviews_updated_at ON public.vocabulary_reviews;
CREATE TRIGGER update_vocabulary_reviews_updated_at
  BEFORE UPDATE ON public.vocabulary_reviews
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_notification_preferences_updated_at ON public.notification_preferences;
CREATE TRIGGER update_notification_preferences_updated_at
  BEFORE UPDATE ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_platform_settings_updated_at ON public.platform_settings;
CREATE TRIGGER update_platform_settings_updated_at
  BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================================
-- BEGIN 20260904_add_rbac_tables.sql
-- ============================================================================
-- SultiAI RBAC Migration
-- Adds roles, permissions, and role_permissions tables

-- ============================================
-- 1. Roles Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.roles (
  role_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 2. Permissions Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.permissions (
  permission_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT
);

-- ============================================
-- 3. Role-Permissions Junction Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id INTEGER NOT NULL REFERENCES public.roles(role_id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES public.permissions(permission_id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ============================================
-- 4. Add roleId FK to users table
-- ============================================
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES public.roles(role_id);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id ON public.role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_id ON public.role_permissions(permission_id);
CREATE INDEX IF NOT EXISTS idx_users_role_id ON public.users(role_id);

-- ============================================
-- 5. Seed Default Roles
-- ============================================
INSERT INTO public.roles (name, description) VALUES
  ('user', 'Regular user with basic access'),
  ('moderator', 'Can moderate community content'),
  ('admin', 'Full system access')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 6. Seed Permissions
-- ============================================
INSERT INTO public.permissions (name, resource, action, description) VALUES
  -- User management
  ('users:read', 'users', 'read', 'View user profiles'),
  ('users:write', 'users', 'write', 'Edit user profiles'),
  ('users:delete', 'users', 'delete', 'Delete user accounts'),
  ('users:manage_roles', 'users', 'manage_roles', 'Assign roles to users'),
  ('users:manage_status', 'users', 'manage_status', 'Approve, ban, or suspend users'),
  -- Community
  ('posts:read', 'posts', 'read', 'View community posts'),
  ('posts:write', 'posts', 'write', 'Create and edit posts'),
  ('posts:delete', 'posts', 'delete', 'Delete community posts'),
  ('posts:moderate', 'posts', 'moderate', 'Feature, hide, or remove posts'),
  ('comments:read', 'comments', 'read', 'View comments'),
  ('comments:write', 'comments', 'write', 'Create comments'),
  ('comments:delete', 'comments', 'delete', 'Delete comments'),
  -- Verifications
  ('verifications:read', 'verifications', 'read', 'View verification requests'),
  ('verifications:approve', 'verifications', 'approve', 'Approve verification requests'),
  -- Lessons
  ('lessons:read', 'lessons', 'read', 'View learning modules'),
  ('lessons:write', 'lessons', 'write', 'Create and edit lessons'),
  ('lessons:delete', 'lessons', 'delete', 'Delete lessons'),
  -- AI features
  ('ai:use', 'ai', 'use', 'Use AI tutor and features'),
  -- Achievements
  ('achievements:read', 'achievements', 'read', 'View achievements'),
  ('achievements:write', 'achievements', 'write', 'Manage achievements'),
  -- Settings
  ('settings:read', 'settings', 'read', 'View platform settings'),
  ('settings:write', 'settings', 'write', 'Modify platform settings'),
  -- Feedback
  ('feedback:read', 'feedback', 'read', 'View feedback'),
  ('feedback:resolve', 'feedback', 'resolve', 'Resolve feedback items'),
  -- Audit
  ('audit:read', 'audit', 'read', 'View audit logs')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 7. Seed Role-Permission Mappings
-- ============================================

-- Admin gets ALL permissions
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r, public.permissions p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Moderator gets limited permissions
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r, public.permissions p
WHERE r.name = 'moderator'
  AND p.name IN (
    'users:read',
    'posts:read', 'posts:write', 'posts:delete', 'posts:moderate',
    'comments:read', 'comments:write', 'comments:delete',
    'verifications:read', 'verifications:approve',
    'lessons:read',
    'achievements:read',
    'feedback:read', 'feedback:resolve',
    'audit:read'
  )
ON CONFLICT DO NOTHING;

-- Regular user gets basic permissions
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r, public.permissions p
WHERE r.name = 'user'
  AND p.name IN (
    'posts:read', 'posts:write',
    'comments:read', 'comments:write',
    'verifications:read',
    'lessons:read',
    'ai:use',
    'achievements:read'
  )
ON CONFLICT DO NOTHING;

-- ============================================
-- 8. Enable RLS on new tables
-- ============================================
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

-- Admin-only policies for role management
CREATE POLICY "Admins can manage roles" ON public.roles FOR ALL USING (true);
CREATE POLICY "Admins can manage permissions" ON public.permissions FOR ALL USING (true);
CREATE POLICY "Admins can manage role permissions" ON public.role_permissions FOR ALL USING (true);

-- ============================================================================
-- BEGIN 20260904_fix_rls_policies.sql
-- ============================================================================
-- SultiAI RLS Policy Fix Migration
-- Replaces all USING(true) policies with proper role-based and ownership policies

-- ============================================
-- Helper function: check if user is admin
-- ============================================
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN (
    SELECT role = 'admin'
    FROM public.users
    WHERE supabase_id = auth.uid()::text
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================
-- Helper function: check if user is moderator or admin
-- ============================================
CREATE OR REPLACE FUNCTION is_moderator_or_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN (
    SELECT role IN ('admin', 'moderator')
    FROM public.users
    WHERE supabase_id = auth.uid()::text
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================
-- Helper function: get user_id from supabase auth.uid
-- ============================================
CREATE OR REPLACE FUNCTION get_user_id()
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT user_id
    FROM public.users
    WHERE supabase_id = auth.uid()::text
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================
-- Drop all existing USING(true) policies
-- ============================================
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND qual = 'true'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- ============================================
-- 1. Users Table
-- ============================================
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING (supabase_id = auth.uid()::text);

CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE USING (supabase_id = auth.uid()::text);

CREATE POLICY "Admins can view all users" ON public.users
  FOR SELECT USING (is_admin());

CREATE POLICY "Admins can manage all users" ON public.users
  FOR ALL USING (is_admin());

CREATE POLICY "Moderators can view all users" ON public.users
  FOR SELECT USING (is_moderator_or_admin());

-- ============================================
-- 2. User Settings
-- ============================================
CREATE POLICY "Users can view own settings" ON public.user_settings
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Users can update own settings" ON public.user_settings
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all settings" ON public.user_settings
  FOR SELECT USING (is_admin());

-- ============================================
-- 3. Saved Phrases
-- ============================================
CREATE POLICY "Users can manage own phrases" ON public.saved_phrases
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all phrases" ON public.saved_phrases
  FOR SELECT USING (is_admin());

-- ============================================
-- 4. Notifications
-- ============================================
CREATE POLICY "Users can view own notifications" ON public.notifications
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Users can manage own notifications" ON public.notifications
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all notifications" ON public.notifications
  FOR SELECT USING (is_admin());

-- ============================================
-- 5. Feedback
-- ============================================
CREATE POLICY "Users can create feedback" ON public.feedback
  FOR INSERT WITH CHECK (user_id = get_user_id());

CREATE POLICY "Users can view own feedback" ON public.feedback
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Admins can manage all feedback" ON public.feedback
  FOR ALL USING (is_admin());

-- ============================================
-- 6. Conversations
-- ============================================
CREATE POLICY "Users can manage own conversations" ON public.conversations
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all conversations" ON public.conversations
  FOR SELECT USING (is_admin());

-- ============================================
-- 7. Conversation Messages
-- ============================================
CREATE POLICY "Users can manage own messages" ON public.conversation_messages
  FOR ALL USING (
    conversation_id IN (
      SELECT conversation_id FROM public.conversations WHERE user_id = get_user_id()
    )
  );

CREATE POLICY "Admins can view all messages" ON public.conversation_messages
  FOR SELECT USING (is_admin());

-- ============================================
-- 8. Speech Records
-- ============================================
CREATE POLICY "Users can manage own speech" ON public.speech_records
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all speech" ON public.speech_records
  FOR SELECT USING (is_admin());

-- ============================================
-- 9. Translations
-- ============================================
CREATE POLICY "Users can view own translations" ON public.translations
  FOR SELECT USING (
    speech_id IN (
      SELECT speech_id FROM public.speech_records WHERE user_id = get_user_id()
    )
  );

CREATE POLICY "Admins can view all translations" ON public.translations
  FOR SELECT USING (is_admin());

-- ============================================
-- 10. Phrase Recommendations
-- ============================================
CREATE POLICY "Users can view own recommendations" ON public.phrase_recommendations
  FOR SELECT USING (
    speech_id IN (
      SELECT speech_id FROM public.speech_records WHERE user_id = get_user_id()
    )
  );

CREATE POLICY "Admins can view all recommendations" ON public.phrase_recommendations
  FOR SELECT USING (is_admin());

-- ============================================
-- 11. Learning Modules (public read)
-- ============================================
CREATE POLICY "Anyone can view modules" ON public.learning_modules
  FOR SELECT USING (true);

CREATE POLICY "Admins can manage modules" ON public.learning_modules
  FOR ALL USING (is_admin());

-- ============================================
-- 12. Learning Progress
-- ============================================
CREATE POLICY "Users can view own progress" ON public.learning_progress
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Users can manage own progress" ON public.learning_progress
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all progress" ON public.learning_progress
  FOR SELECT USING (is_admin());

-- ============================================
-- 13. Community Posts
-- ============================================
CREATE POLICY "Anyone can view published posts" ON public.community_posts
  FOR SELECT USING (true);

CREATE POLICY "Users can create posts" ON public.community_posts
  FOR INSERT WITH CHECK (user_id = get_user_id());

CREATE POLICY "Users can update own posts" ON public.community_posts
  FOR UPDATE USING (user_id = get_user_id());

CREATE POLICY "Users can delete own posts" ON public.community_posts
  FOR DELETE USING (user_id = get_user_id());

CREATE POLICY "Admins can manage all posts" ON public.community_posts
  FOR ALL USING (is_admin());

CREATE POLICY "Moderators can moderate posts" ON public.community_posts
  FOR UPDATE USING (is_moderator_or_admin());

CREATE POLICY "Moderators can delete posts" ON public.community_posts
  FOR DELETE USING (is_moderator_or_admin());

-- ============================================
-- 14. Comments
-- ============================================
CREATE POLICY "Anyone can view comments" ON public.comments
  FOR SELECT USING (true);

CREATE POLICY "Users can create comments" ON public.comments
  FOR INSERT WITH CHECK (user_id = get_user_id());

CREATE POLICY "Users can update own comments" ON public.comments
  FOR UPDATE USING (user_id = get_user_id());

CREATE POLICY "Users can delete own comments" ON public.comments
  FOR DELETE USING (user_id = get_user_id());

CREATE POLICY "Admins can manage all comments" ON public.comments
  FOR ALL USING (is_admin());

CREATE POLICY "Moderators can delete comments" ON public.comments
  FOR DELETE USING (is_moderator_or_admin());

-- ============================================
-- 15. Community Reports
-- ============================================
CREATE POLICY "Users can create reports" ON public.community_reports
  FOR INSERT WITH CHECK (reporter_id = get_user_id());

CREATE POLICY "Users can view own reports" ON public.community_reports
  FOR SELECT USING (reporter_id = get_user_id());

CREATE POLICY "Admins can manage all reports" ON public.community_reports
  FOR ALL USING (is_admin());

CREATE POLICY "Moderators can view and update reports" ON public.community_reports
  FOR SELECT USING (is_moderator_or_admin());

CREATE POLICY "Moderators can update reports" ON public.community_reports
  FOR UPDATE USING (is_moderator_or_admin());

-- ============================================
-- 16. Learner Profiles
-- ============================================
CREATE POLICY "Users can view own profile" ON public.learner_profiles
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Users can update own profile" ON public.learner_profiles
  FOR UPDATE USING (user_id = get_user_id());

CREATE POLICY "Admins can view all profiles" ON public.learner_profiles
  FOR SELECT USING (is_admin());

-- ============================================
-- 17. Preserved Words
-- ============================================
CREATE POLICY "Anyone can view approved words" ON public.preserved_words
  FOR SELECT USING (status = 'approved' OR is_moderator_or_admin());

CREATE POLICY "Users can submit words" ON public.preserved_words
  FOR INSERT WITH CHECK (submitted_by = get_user_id());

CREATE POLICY "Admins can manage all words" ON public.preserved_words
  FOR ALL USING (is_admin());

CREATE POLICY "Moderators can verify words" ON public.preserved_words
  FOR UPDATE USING (is_moderator_or_admin());

-- ============================================
-- 18. Tutor Sessions
-- ============================================
CREATE POLICY "Users can manage own sessions" ON public.tutor_sessions
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all sessions" ON public.tutor_sessions
  FOR SELECT USING (is_admin());

-- ============================================
-- 19. Pronunciation Attempts
-- ============================================
CREATE POLICY "Users can manage own attempts" ON public.pronunciation_attempts
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all attempts" ON public.pronunciation_attempts
  FOR SELECT USING (is_admin());

-- ============================================
-- 20. Vocabulary Reviews
-- ============================================
CREATE POLICY "Users can manage own vocabulary" ON public.vocabulary_reviews
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all vocabulary" ON public.vocabulary_reviews
  FOR SELECT USING (is_admin());

-- ============================================
-- 21. Conversation Summaries
-- ============================================
CREATE POLICY "Users can manage own summaries" ON public.conversation_summaries
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all summaries" ON public.conversation_summaries
  FOR SELECT USING (is_admin());

-- ============================================
-- 22. XP Logs
-- ============================================
CREATE POLICY "Users can view own XP" ON public.xp_logs
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Admins can view all XP" ON public.xp_logs
  FOR SELECT USING (is_admin());

-- ============================================
-- 23. AI Recommendations
-- ============================================
CREATE POLICY "Users can manage own recommendations" ON public.ai_recommendations
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all recommendations" ON public.ai_recommendations
  FOR SELECT USING (is_admin());

-- ============================================
-- 24. User Sessions (refresh tokens)
-- ============================================
CREATE POLICY "Users can manage own sessions" ON public.user_sessions
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all sessions" ON public.user_sessions
  FOR SELECT USING (is_admin());

-- ============================================
-- 25. Notification Preferences
-- ============================================
CREATE POLICY "Users can manage own preferences" ON public.notification_preferences
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all preferences" ON public.notification_preferences
  FOR SELECT USING (is_admin());

-- ============================================
-- 26. Learning Analytics
-- ============================================
CREATE POLICY "Users can view own analytics" ON public.learning_analytics
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Admins can view all analytics" ON public.learning_analytics
  FOR SELECT USING (is_admin());

-- ============================================
-- 27. Bookmarks
-- ============================================
CREATE POLICY "Users can manage own bookmarks" ON public.bookmarks
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all bookmarks" ON public.bookmarks
  FOR SELECT USING (is_admin());

-- ============================================
-- 28. Likes
-- ============================================
CREATE POLICY "Users can manage own likes" ON public.likes
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all likes" ON public.likes
  FOR SELECT USING (is_admin());

-- ============================================
-- 29. Audit Logs (admin only)
-- ============================================
CREATE POLICY "Admins can view all audit logs" ON public.audit_logs
  FOR SELECT USING (is_admin());

CREATE POLICY "System can insert audit logs" ON public.audit_logs
  FOR INSERT WITH CHECK (true);

-- ============================================
-- 30. Daily Activity
-- ============================================
CREATE POLICY "Users can view own activity" ON public.daily_activity
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Users can manage own activity" ON public.daily_activity
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all activity" ON public.daily_activity
  FOR SELECT USING (is_admin());

-- ============================================
-- 31. User Achievements
-- ============================================
CREATE POLICY "Users can view own achievements" ON public.user_achievements
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Admins can manage all achievements" ON public.user_achievements
  FOR ALL USING (is_admin());

-- ============================================
-- 32. User Badges
-- ============================================
CREATE POLICY "Users can view own badges" ON public.user_badges
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Admins can manage all badges" ON public.user_badges
  FOR ALL USING (is_admin());

-- ============================================
-- 33. Completed Challenges
-- ============================================
CREATE POLICY "Users can view own challenges" ON public.completed_challenges
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Users can manage own challenges" ON public.completed_challenges
  FOR ALL USING (user_id = get_user_id());

CREATE POLICY "Admins can view all challenges" ON public.completed_challenges
  FOR SELECT USING (is_admin());

-- ============================================
-- 34. Follows
-- ============================================
CREATE POLICY "Users can manage own follows" ON public.follows
  FOR ALL USING (follower_id = get_user_id());

CREATE POLICY "Users can view own followers" ON public.follows
  FOR SELECT USING (following_id = get_user_id());

CREATE POLICY "Admins can view all follows" ON public.follows
  FOR SELECT USING (is_admin());

-- ============================================
-- 35. Verifications
-- ============================================
CREATE POLICY "Users can view own verifications" ON public.verifications
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Users can create verifications" ON public.verifications
  FOR INSERT WITH CHECK (user_id = get_user_id());

CREATE POLICY "Admins can manage all verifications" ON public.verifications
  FOR ALL USING (is_admin());

CREATE POLICY "Moderators can verify submissions" ON public.verifications
  FOR UPDATE USING (is_moderator_or_admin());

-- ============================================
-- 36. Verification Requests
-- ============================================
CREATE POLICY "Users can view own requests" ON public.verification_requests
  FOR SELECT USING (user_id = get_user_id());

CREATE POLICY "Users can create requests" ON public.verification_requests
  FOR INSERT WITH CHECK (user_id = get_user_id());

CREATE POLICY "Admins can manage all requests" ON public.verification_requests
  FOR ALL USING (is_admin());

CREATE POLICY "Moderators can view and approve requests" ON public.verification_requests
  FOR SELECT USING (is_moderator_or_admin());

CREATE POLICY "Moderators can approve requests" ON public.verification_requests
  FOR UPDATE USING (is_moderator_or_admin());

-- ============================================
-- 37. Avatars (public read)
-- ============================================
CREATE POLICY "Anyone can view avatars" ON public.avatars
  FOR SELECT USING (true);

CREATE POLICY "Admins can manage avatars" ON public.avatars
  FOR ALL USING (is_admin());

-- ============================================
-- 38. Platform Settings (admin only)
-- ============================================
CREATE POLICY "Admins can manage platform settings" ON public.platform_settings
  FOR ALL USING (is_admin());

CREATE POLICY "Authenticated users can read platform settings" ON public.platform_settings
  FOR SELECT USING (auth.role() = 'authenticated');

-- ============================================================================
-- BEGIN 20260926_learning_path_integration.sql
-- ============================================================================
-- Learning path integration: stable module keys, ordered modules, lesson content,
-- and per-user progress integrity.

-- ============================================
-- 1. Module identity and ordering
-- ============================================
ALTER TABLE public.learning_modules
  ADD COLUMN IF NOT EXISTS module_key TEXT;
ALTER TABLE public.learning_modules
  ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;

-- Backfill keys for any modules that predate this change, from a slugified title.
UPDATE public.learning_modules
SET module_key = lower(regexp_replace(trim(module_title), '[^a-zA-Z0-9]+', '_', 'g'))
WHERE module_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_modules_key
  ON public.learning_modules (module_key)
  WHERE module_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_learning_modules_sort_order
  ON public.learning_modules (sort_order, module_id);

-- ============================================
-- 2. Lesson content
-- ============================================
CREATE TABLE IF NOT EXISTS public.lesson_items (
  item_id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES public.learning_modules(module_id) ON DELETE CASCADE,
  section_title TEXT,
  native_text TEXT NOT NULL,
  english_text TEXT,
  note TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.lesson_items
  ADD COLUMN IF NOT EXISTS section_title TEXT;

CREATE INDEX IF NOT EXISTS idx_lesson_items_module
  ON public.lesson_items (module_id, sort_order);

ALTER TABLE public.lesson_items ENABLE ROW LEVEL SECURITY;

-- Lesson content is course material: readable by any signed-in user, writable by admins.
DROP POLICY IF EXISTS "Anyone can view lesson items" ON public.lesson_items;
CREATE POLICY "Anyone can view lesson items" ON public.lesson_items
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can manage lesson items" ON public.lesson_items;
CREATE POLICY "Admins can manage lesson items" ON public.lesson_items
  FOR ALL USING (is_admin());

-- ============================================
-- 3. Progress integrity
-- ============================================
ALTER TABLE public.learning_progress
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- One row per user per module. Keep the furthest-progressed row when collapsing dupes.
DELETE FROM public.learning_progress lp
USING public.learning_progress dup
WHERE dup.user_id = lp.user_id
  AND dup.module_id = lp.module_id
  AND dup.progress_id < lp.progress_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_progress_user_module
  ON public.learning_progress (user_id, module_id);

-- Reject percentages outside 0-100.
ALTER TABLE public.learning_progress
  DROP CONSTRAINT IF EXISTS learning_progress_completion_percent_range;
ALTER TABLE public.learning_progress
  ADD CONSTRAINT learning_progress_completion_percent_range
  CHECK (completion_percent IS NULL OR (completion_percent >= 0 AND completion_percent <= 100));

UPDATE public.learning_progress
SET completion_percent = 0
WHERE completion_percent IS NULL OR completion_percent < 0;

UPDATE public.learning_progress
SET completion_percent = 100
WHERE completion_percent > 100;

-- ============================================
-- 4. Seed the learning path
-- ============================================
INSERT INTO public.learning_modules (module_title, module_key, sort_order, difficulty, language)
VALUES
  ('Voice Practice',        'voice_practice',       0,  'beginner', 'Bisaya'),
  ('Scenario Practice',     'scenario_practice',    1,  'beginner', 'Bisaya'),
  ('Phrasebook',            'phrasebook',           2,  'beginner', 'Bisaya'),
  ('Flashcards',            'flashcards',           3,  'beginner', 'Bisaya'),
  ('Pronunciation Lab',     'pronunciation_lab',    4,  'beginner', 'Bisaya'),
  ('Grammar',               'grammar',              5,  'beginner', 'Bisaya'),
  ('Vocabulary Notebook',   'vocabulary_notebook',  6,  'beginner', 'Bisaya'),
  ('Listening',             'listening',            7,  'beginner', 'Bisaya'),
  ('Writing',               'writing',              8,  'beginner', 'Bisaya'),
  ('Reading',               'reading',              9,  'beginner', 'Bisaya'),
  ('Sulti Switch',          'sulti_switch',         10, 'beginner', 'Bisaya'),
  ('Culture Notes',         'culture_notes',        11, 'beginner', 'Bisaya'),
  ('Review Center',         'review_center',        12, 'beginner', 'Bisaya')
ON CONFLICT DO NOTHING;

-- Seed lesson content, keyed by module_key so re-running is safe.
INSERT INTO public.lesson_items (module_id, section_title, native_text, english_text, note, sort_order)
SELECT m.module_id, seed.section_title, seed.native_text, seed.english_text, seed.note, seed.sort_order
FROM (
  VALUES
    ('scenario_practice', 'Scenarios',        'Palengke',        'At the Market',        'Bargaining & buying food', 0),
    ('scenario_practice', 'Scenarios',        'Jeepney',         'Riding a Jeepney',     'Routes & paying the driver', 1),
    ('scenario_practice', 'Scenarios',        'Karenderia',      'Eating Out',           'Ordering at a carenderia', 2),
    ('scenario_practice', 'Scenarios',        'Ospital',         'At the Hospital',      'Emergency & checkup phrases', 3),
    ('grammar',           'Core Rules',       'Ang + noun',      'The subject marker',   'Ang akong amigo = my friend', 0),
    ('grammar',           'Core Rules',       'Si + name',       'Proper noun marker',   'Si Maria muadto = Maria will go', 1),
    ('grammar',           'Core Rules',       'nag-/ni-',        'Verb focus prefixes',  'nagluto = cooking', 2),
    ('grammar',           'Core Rules',       'Palihog',         'Please (softener)',    'Palihog ug hatag = please give', 3),
    ('listening',         'Daily Expressions','Kumusta ka?',     'How are you?',         'Casual greeting', 0),
    ('listening',         'Daily Expressions','Asa ka paingon?', 'Where are you going?', 'Small talk', 1),
    ('listening',         'Daily Expressions','Moadto ko sa merkado', 'I am going to the market', 'Future tense', 2),
    ('listening',         'Daily Expressions','Nindot ang panahon karon', 'The weather is nice today', 'Weather small talk', 3),
    ('writing',           'Vocabulary Bank',  'matulog',         'to sleep',             'verb', 0),
    ('writing',           'Vocabulary Bank',  'mumata',          'to wake up',           'verb', 1),
    ('writing',           'Vocabulary Bank',  'pamahaw',         'breakfast',            'noun', 2),
    ('writing',           'Vocabulary Bank',  'trabaho',         'work',                 'noun', 3),
    ('reading',           'Today''s Passage', 'Ako si Juan.',    'I am Juan.',           'Introduction', 0),
    ('reading',           'Today''s Passage', 'Taga-Cebu ko.',   'I am from Cebu.',      'Origin', 1),
    ('reading',           'Today''s Passage', 'Nagtuon ko og Bisaya.', 'I am studying Bisaya.', 'Study', 2),
    ('reading',           'Today''s Passage', 'Gusto ko makakat-on og dugang.', 'I want to learn more.', 'Desire', 3),
    ('sulti_switch',      'Practice Pairs',   'Unsa ni?',        'What is this?',        'Question', 0),
    ('sulti_switch',      'Practice Pairs',   'Gusto ko ani.',   'I want this.',         'Preference', 1),
    ('sulti_switch',      'Practice Pairs',   'Pila ni?',        'How much is this?',    'Shopping', 2),
    ('sulti_switch',      'Practice Pairs',   'Asa ang banyo?',  'Where is the bathroom?', 'Directions', 3),
    ('culture_notes',     'Did You Know?',    'Sinulog Festival', 'Cebu''s grandest celebration', 'Every January in Cebu City', 0),
    ('culture_notes',     'Did You Know?',    'Bahala Na',       'Come what may',        'A famous Filipino mindset', 1),
    ('culture_notes',     'Did You Know?',    'Po & Opo',        'Respect markers',      'Shown to elders and authority', 2),
    ('culture_notes',     'Did You Know?',    'Kamayan',         'Eating with hands',    'Common in casual meals', 3),
    ('review_center',     'Key Phrases',      'Salamat',         'Thank you',            'Essential', 0),
    ('review_center',     'Key Phrases',      'Palihog',         'Please',               'Essential', 1),
    ('review_center',     'Key Phrases',      'Kumusta ka?',     'How are you?',         'Essential', 2),
    ('review_center',     'Key Phrases',      'Gihigugma ko ikaw', 'I love you',          'Essential', 3)
) AS seed(module_key, section_title, native_text, english_text, note, sort_order)
JOIN public.learning_modules m ON m.module_key = seed.module_key
WHERE NOT EXISTS (
  SELECT 1 FROM public.lesson_items li
  WHERE li.module_id = m.module_id AND li.native_text = seed.native_text
);

-- ============================================================================
-- BEGIN 20261001_gamification_integrity.sql
-- ============================================================================
-- Gamification integrity: dedup constraints for XP/daily-reward/challenge awards,
-- a real learning_sessions table for time-tracking, module-level mastery, and
-- two RLS tightenings (audit_logs forgery, lesson_items anon read).

-- xp_logs: one credited row per (user, idempotency key). Rows with a NULL key
-- are exempt (Postgres treats NULLs as distinct for a plain UNIQUE constraint),
-- so legacy/unkeyed callers keep working as unconditional increments.
ALTER TABLE public.xp_logs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_logs_idempotency
  ON public.xp_logs (user_id, idempotency_key);

-- daily_activity: one claim per user per day.
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_activity_user_date
  ON public.daily_activity (user_id, activity_date);

-- completed_challenges: add the columns challenge-completion logic already
-- assumes exist, then dedup per user/challenge/day.
ALTER TABLE public.completed_challenges ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'daily';
ALTER TABLE public.completed_challenges ADD COLUMN IF NOT EXISTS completed_date TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD');
CREATE UNIQUE INDEX IF NOT EXISTS idx_completed_challenges_user_challenge_date
  ON public.completed_challenges (user_id, challenge_id, completed_date);

-- learning_sessions: real time-tracking behind the Daily Learning Goal
-- (distinct from tutor_sessions, which is chat-message-oriented).
CREATE TABLE IF NOT EXISTS public.learning_sessions (
  session_id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  module_id INTEGER REFERENCES public.learning_modules(module_id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER DEFAULT 0,
  xp_earned INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_learning_sessions_user_date
  ON public.learning_sessions (user_id, started_at);

ALTER TABLE public.learning_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own learning sessions" ON public.learning_sessions;
CREATE POLICY "Users manage own learning sessions" ON public.learning_sessions
  FOR ALL USING (user_id = get_user_id() OR is_admin())
  WITH CHECK (user_id = get_user_id() OR is_admin());

-- Module/lesson mastery (only per-vocab-word mastery existed before).
ALTER TABLE public.learning_progress ADD COLUMN IF NOT EXISTS mastery_score REAL DEFAULT 0;
ALTER TABLE public.learning_progress
  DROP CONSTRAINT IF EXISTS learning_progress_mastery_score_check;
ALTER TABLE public.learning_progress
  ADD CONSTRAINT learning_progress_mastery_score_check
  CHECK (mastery_score >= 0 AND mastery_score <= 100);

-- RLS tightening #1: audit_logs must not be forgeable by an arbitrary
-- authenticated/anon caller. Replaces the WITH CHECK (true) policy from
-- 20260904_fix_rls_policies.sql:402 ("System can insert audit logs").
DROP POLICY IF EXISTS "System can insert audit logs" ON public.audit_logs;
CREATE POLICY "Service role and admins can insert audit logs" ON public.audit_logs
  FOR INSERT WITH CHECK (is_admin() OR auth.role() = 'service_role');

-- RLS tightening #2: lesson_items should require authenticated, not anon.
-- Replaces "Anyone can view lesson items" from
-- 20260926_learning_path_integration.sql:48.
DROP POLICY IF EXISTS "Anyone can view lesson items" ON public.lesson_items;
CREATE POLICY "Authenticated users can view lesson items" ON public.lesson_items
  FOR SELECT TO authenticated USING (true);

-- ============================================================================
-- BEGIN 20261006_auth_provisioning.sql
-- ============================================================================
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
  (COALESCE(u.is_native_speaker, 0) <> 0) AS is_native,
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

-- ============================================================================
-- BEGIN 20261007120000_harden_role_and_rls_policies.sql
-- ============================================================================
-- SultiAI: close the privilege-escalation paths found in the alpha test.
--
-- Findings addressed (full write-up in docs/ALPHA_EVALUATION.md):
--
--   C-1  Any authenticated user could set their own `public.users.role` to
--        'admin'. `20260904_fix_rls_policies.sql:72-73` grants a self-UPDATE
--        with no WITH CHECK and no column restriction, so a single request of
--        `update public.users set role='admin'` satisfied `is_admin()` and
--        unlocked every `FOR ALL` admin policy in that file.
--
--   C-2  `handle_new_auth_user()` derived the role from `raw_user_meta_data`
--        (`20261006_auth_provisioning.sql:79`, and :37 in the backfill).
--        `raw_user_meta_data` is whatever the caller passed to
--        `supabase.auth.signUp({ options: { data: ... } })`, so registering with
--        `data: { role: 'admin' }` provisioned an admin and bypassed C-1.
--
--   M-4  `is_admin()`, `is_moderator_or_admin()` and `get_user_id()` are all
--        `SECURITY DEFINER` with no `SET search_path`
--        (`20260904_fix_rls_policies.sql:7-47`), leaving them open to
--        search-path hijacking. The triggers in 20261006 already set it; this
--        is the same class of mistake in the other direction.
--
--   M-6  (found while applying the above) `20260904_add_rbac_tables.sql:144-146`
--        creates three policies commented "Admin-only" that are literally
--        `USING (true)` - any authenticated user could rewrite the role and
--        permission catalogue. The `DO` block in 20260904_fix_rls_policies.sql
--        drops `qual = 'true'` policies, which most likely removed them, but
--        that leaves the RBAC tables with RLS enabled and NO policy at all.
--        Recreated below with the admin check the comment always claimed.
--
--   M-7  (found while applying the above) `public.users.is_native_speaker` is
--        read by the `post_feed` view (`20261006_auth_provisioning.sql:232`)
--        but is added by no migration in this directory - it only exists in the
--        deleted server's `server/migrations/001_new_tables.sql:105`. On a
--        database provisioned from `supabase/migrations/` alone the view cannot
--        be created. Added here (idempotent) and the views are reissued.
--
-- Nothing here reintroduces a server or a service-role credential. Every
-- function below resolves the caller from `auth.uid()`, never from a parameter.

-- ============================================================================
-- 1. M-4 - pin search_path on every SECURITY DEFINER helper
-- ============================================================================
-- These three are called from RLS policy expressions on every request, so they
-- must not be able to resolve a name through an attacker-influenced path.

ALTER FUNCTION public.is_admin() SET search_path = public;
ALTER FUNCTION public.is_moderator_or_admin() SET search_path = public;
ALTER FUNCTION public.get_user_id() SET search_path = public;

-- ============================================================================
-- 2. C-2 - the signup role can no longer come from the caller
-- ============================================================================

-- 2a. Strip privilege-bearing keys from the metadata BEFORE it is persisted.
-- A BEFORE trigger is the only kind whose NEW assignment reaches the table;
-- an AFTER trigger would silently discard the change.
--
-- Covers UPDATE as well as INSERT. On UPDATE this still does not protect
-- `public.users.role` - `handle_auth_user_metadata_update` never wrote role, so
-- there is nothing to protect - but it stops the claim being re-added to
-- `raw_user_meta_data` and reappearing anywhere that reads metadata.
CREATE OR REPLACE FUNCTION public.sanitize_new_user_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.raw_user_meta_data IS NOT NULL THEN
    -- `role` is the escalation vector. `permissions` is the same class of
    -- claim: UserContext.hasPermission() reads it straight off the metadata
    -- (src/context/UserContext.js:239-243), so a forged value would drive the
    -- UI's permission gates once they are wired up.
    NEW.raw_user_meta_data := NEW.raw_user_meta_data - 'role' - 'permissions';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_sanitize_metadata ON auth.users;
CREATE TRIGGER on_auth_user_sanitize_metadata
  BEFORE INSERT OR UPDATE OF raw_user_meta_data ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sanitize_new_user_metadata();

-- 2b. Replace the provisioning trigger so the role is a constant, not a claim.
-- The rest of the body is byte-for-byte the logic from
-- 20261006_auth_provisioning.sql:52-101, so behaviour is otherwise unchanged.
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
  v_country     := COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'country', ''), '');

  -- SECURITY DEFINER so the insert bypasses RLS: the "Users can view own
  -- profile" policy grants only SELECT/UPDATE, never INSERT, so a brand-new
  -- auth user could not provision itself and every later read would fail
  -- closed on a NULL get_user_id().
  --
  -- ROLE IS A CONSTANT. It is deliberately NOT read from raw_user_meta_data.
  -- Admins are promoted out of band - see docs/DEPLOYMENT_RUNBOOK.md.
  INSERT INTO public.users (fullname, email, password_hash, supabase_id, role, preferred_lang, learning_lang, country)
  VALUES (v_fullname, NEW.email, 'supabase-managed', NEW.id::text,
          'user',
          v_native_lang, v_target_lang, v_country)
  ON CONFLICT (supabase_id) DO UPDATE
    SET fullname      = COALESCE(NULLIF(EXCLUDED.fullname, ''), public.users.fullname),
        preferred_lang = COALESCE(NULLIF(EXCLUDED.preferred_lang, ''), public.users.preferred_lang),
        learning_lang  = COALESCE(NULLIF(EXCLUDED.learning_lang, ''), public.users.learning_lang),
        country        = COALESCE(NULLIF(EXCLUDED.country, ''), public.users.country)
  RETURNING user_id INTO v_user_id;

  INSERT INTO public.user_settings (user_id, dark_mode, speech_speed, voice_gender)
  VALUES (v_user_id, 0, 1.0, 'neutral')
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.learner_profiles (user_id, level, total_xp, coins, streak, daily_xp, daily_goal, total_sessions)
  VALUES (v_user_id, 'beginner', 0, 0, 0, 0, 50, 0)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- 2c. Users created before this migration may already hold a role that came
-- from their own signup metadata. This cannot be corrected automatically -
-- demoting on a guess could lock out a legitimate admin - so it is only
-- surfaced. Run it by hand and review the result:
--
--   SELECT u.user_id, u.email, u.role, u.created_at, u.supabase_id IS NULL AS orphaned
--   FROM public.users u
--   WHERE u.role <> 'user'
--   ORDER BY u.created_at;
--
-- Anything listed there that you do not recognise should be demoted:
--   UPDATE public.users SET role = 'user' WHERE user_id = <id>;
-- (Only admins can do that anyway, so it must be run from the SQL editor.)

-- ============================================================================
-- 3. C-1 - a user may no longer write their own role
-- ============================================================================

-- 3a. Column-level privileges. A table-level UPDATE has to go first, otherwise
-- it subsumes the column grants. `api.updateProfile` (src/services/api.js:379-408)
-- and `OnboardingForm` are the only client writers, and between them they touch
-- exactly these six columns.
REVOKE UPDATE ON public.users FROM authenticated;

GRANT UPDATE (fullname, username, preferred_lang, learning_lang, country, avatar_id)
  ON public.users TO authenticated;

-- 3b. Defence in depth: even if a future grant is too broad, or a service-role
-- path forgets to filter columns, a role change still has to clear this.
CREATE OR REPLACE FUNCTION public.guard_users_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- is_admin() reads the pre-update row, which is exactly what we want here.
  IF COALESCE(is_admin(), false) THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Only an administrator can change a user role.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    RAISE EXCEPTION 'Password hashes are managed by Supabase Auth.'
      USING ERRCODE = '42501';
  END IF;

  -- Rebinding the row to a different auth identity is account takeover.
  IF NEW.supabase_id IS DISTINCT FROM OLD.supabase_id THEN
    RAISE EXCEPTION 'The linked auth identity cannot be changed from the client.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'The primary key cannot be changed.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.is_verified IS DISTINCT FROM OLD.is_verified
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.role_id IS DISTINCT FROM OLD.role_id THEN
    RAISE EXCEPTION 'Verification, status and role mapping are administrator-only.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_users_privileged_columns ON public.users;
CREATE TRIGGER guard_users_privileged_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_users_privileged_columns();

-- ============================================================================
-- 4. M-6 - the RBAC catalogue is admin-only, as its comment always said
-- ============================================================================
-- DROP first: the existing policies have the same names but a `USING (true)`
-- body, and CREATE POLICY would otherwise collide.

DROP POLICY IF EXISTS "Admins can manage roles" ON public.roles;
CREATE POLICY "Admins can manage roles" ON public.roles
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins can manage permissions" ON public.permissions;
CREATE POLICY "Admins can manage permissions" ON public.permissions
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admins can manage role permissions" ON public.role_permissions;
CREATE POLICY "Admins can manage role permissions" ON public.role_permissions
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- ============================================================================
-- 5. M-7 - the missing column, and reissue the two definer-rights views
-- ============================================================================
-- `is_native_speaker` is INTEGER (see server/migrations/001_new_tables.sql:105),
-- so the view maps it to a boolean with `COALESCE(u.is_native_speaker, 0) <> 0`.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_native_speaker INTEGER DEFAULT 0;

-- Reissued from 20261006_auth_provisioning.sql:221-266, column for column, so
-- the views exist even if that migration failed partway on a database that lacked
-- the column. Still NO security_invoker: `users` RLS exposes only the caller's own
-- row, so an invoker-rights view would return one row and every author would
-- render as "Anonymous".
--
-- CREATE OR REPLACE rather than the DROP + CREATE that 20261006 used. REPLACE
-- keeps existing grants and does not fail if something else came to depend on
-- the view; a plain DROP would error on a dependent object and take the grants
-- with it. It requires the column list to match exactly, which it does here
-- because it was copied from that file.
CREATE OR REPLACE VIEW public.post_feed AS
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
  (COALESCE(u.is_native_speaker, 0) <> 0) AS is_native,
  p.created_at,
  p.likes_count            AS likes,
  COALESCE(cc.comment_count, 0) AS comments,
  a.avatar_image           AS author_avatar
FROM public.community_posts p
JOIN public.users u ON u.user_id = p.user_id
LEFT JOIN public.avatars a ON a.avatar_id = u.avatar_id
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

CREATE OR REPLACE VIEW public.comment_feed AS
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

-- Grant scopes are handled in 20261007130000_award_xp_and_tighten_grants.sql:
-- `REVOKE` from `anon` first, then `GRANT` to `authenticated` only. The REVOKE
-- comes first on purpose - the reverse order would leave the anon grant in place.
--
-- Nothing is granted here. CREATE OR REPLACE preserves whatever grants already
-- exist, and 20261007130000 sets the end state either way, so this file does not
-- need to know whether 20261006 actually applied.

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- BEGIN 20261007130000_award_xp_and_tighten_grants.sql
-- ============================================================================
-- SultiAI: server-authoritative XP, tightened cross-user grants, audit trail.
--
-- Findings addressed (full write-up in docs/ALPHA_EVALUATION.md):
--
--   M-1  XP/coin balances were a client-side read-modify-write
--        (`src/services/api.js` `awardXp`): insert an `xp_logs` row, read
--        `learner_profiles`, then write the new total. Two devices - or one
--        device with a double-tapped button - both read the same total and the
--        second write silently discards the first. Worse, `addXp` in
--        `src/context/GameContext.js:117` pushed an ABSOLUTE total
--        (`syncToServer({ xp: newXp })`), so the balance was whatever the client
--        claimed, not what the user earned.
--        Replaced by `public.award_xp()`, which increments inside one
--        transaction with `SELECT ... FOR UPDATE` and an idempotency key.
--
--   M-2  `leaderboard`, `post_feed` and `comment_feed` were granted to `anon`.
--        They are created WITHOUT `security_invoker` (deliberately - see
--        20261006_auth_provisioning.sql:175-182), so they run with the definer's
--        privileges and bypass RLS. Every user's fullname, avatar, total_xp,
--        streak, level and last_active were readable by an unauthenticated
--        caller holding only the public anon key.
--
--   M-8  `audit_logs` existed with an admin-only read policy, but nothing ever
--        wrote to it. `user_id` on a row proves ownership, not history: a user
--        could delete a post or inflate a balance with no remaining trace.
--
--   M-9  (found while applying the above) the client could write its own
--        `learner_profiles.total_xp` / `coins` / `streak` directly, because
--        20260904_fix_rls_policies.sql:276-277 grants an unqualified
--        self-UPDATE.
--
-- Still true after this migration, and worth recording: a signed-in user can
-- call `award_xp` with any positive amount. It is now *recorded* and
-- *idempotent* rather than *arbitrary*, but the amount is not yet validated
-- against what the learner actually did. Closing that needs the award sites to
-- verify server-side, which is a larger piece of work - see the Residual Risks
-- section of docs/ALPHA_EVALUATION.md.

-- ============================================================================
-- 1. M-1 - award_xp: one transaction, atomic increment, idempotent
-- ============================================================================
-- SECURITY DEFINER because the client must no longer hold INSERT/UPDATE on
-- xp_logs, daily_activity or the balance columns of learner_profiles.
--
-- The caller is ALWAYS resolved from auth.uid() via get_user_id(). There is no
-- user_id parameter, so there is no way to credit somebody else's balance.

CREATE OR REPLACE FUNCTION public.award_xp(
  p_xp             INTEGER DEFAULT 0,
  p_coins          INTEGER DEFAULT 0,
  p_source         TEXT    DEFAULT 'unknown',
  p_idempotency_key TEXT   DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   INTEGER;
  v_xp        INTEGER := GREATEST(COALESCE(p_xp, 0), 0);
  v_coins     INTEGER := GREATEST(COALESCE(p_coins, 0), 0);
  v_today     TEXT    := to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD');
  v_yesterday TEXT    := to_char(((now() AT TIME ZONE 'utc') - INTERVAL '1 day'), 'YYYY-MM-DD');
  v_last_date TEXT;
  v_log_id    TEXT;
  v_claimed   BOOLEAN := false;
  v_profile   RECORD;
BEGIN
  v_user_id := get_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You are not signed in.' USING ERRCODE = '42501';
  END IF;

  IF v_xp = 0 AND v_coins = 0 THEN
    RETURN jsonb_build_object('credited', false, 'already_claimed', false);
  END IF;

  -- Serialise every award for this user. Two concurrent calls queue here
  -- instead of both reading the same starting balance.
  SELECT total_xp, coins, streak
    INTO v_profile
    FROM public.learner_profiles
   WHERE user_id = v_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Your learner profile is missing. Please sign out and sign in again.';
  END IF;

  -- Idempotency gate. The unique index idx_xp_logs_idempotency
  -- (20261001_gamification_integrity.sql:9-10) is what makes ON CONFLICT
  -- DO NOTHING atomic here: exactly one caller inserts the row, every other
  -- caller gets zero rows back and exits without crediting.
  IF p_idempotency_key IS NOT NULL THEN
    v_log_id := 'xp_'
      || to_char((now() AT TIME ZONE 'utc'), 'YYYYMMDDHH24MISSMS')
      || '_'
      || substr(md5(random()::text), 1, 8);

    INSERT INTO public.xp_logs (id, user_id, amount, source, description, idempotency_key, timestamp)
    VALUES (v_log_id, v_user_id, v_xp, p_source, p_source, p_idempotency_key, now())
    ON CONFLICT (user_id, idempotency_key) DO NOTHING;

    -- FOUND is set by the INSERT: true when this caller inserted the row, false
    -- when the unique index turned it into a no-op because someone else already
    -- holds this key.
    v_claimed := FOUND;
  ELSE
    -- No key, so there is nothing to collide with and the insert always succeeds.
    -- v_claimed MUST be set here: it defaults to false, and the
    -- `IF NOT v_claimed` gate below reads false as "already claimed", which
    -- would silently swallow every un-keyed award.
    v_log_id := 'xp_'
      || to_char((now() AT TIME ZONE 'utc'), 'YYYYMMDDHH24MISSMS')
      || '_'
      || substr(md5(random()::text), 1, 8);

    INSERT INTO public.xp_logs (id, user_id, amount, source, description, timestamp)
    VALUES (v_log_id, v_user_id, v_xp, p_source, p_source, now());

    v_claimed := true;
  END IF;

  IF NOT v_claimed THEN
    RETURN jsonb_build_object(
      'credited', false,
      'already_claimed', true,
      'total_xp', v_profile.total_xp,
      'coins', v_profile.coins
    );
  END IF;

  -- daily_activity drives the weekly XP chart and the streak. ON CONFLICT
  -- honours idx_daily_activity_user_date, so one row per user per day.
  IF v_xp > 0 THEN
    INSERT INTO public.daily_activity (user_id, activity_date, xp_earned)
    VALUES (v_user_id, v_today, v_xp)
    ON CONFLICT (user_id, activity_date)
    DO UPDATE SET xp_earned = public.daily_activity.xp_earned + EXCLUDED.xp_earned;

    -- Streak: consecutive days ending today or yesterday. Mirrors the client
    -- rule in GameContext.checkStreak (src/context/GameContext.js:83-104).
    SELECT max(activity_date)
      INTO v_last_date
      FROM public.daily_activity
     WHERE user_id = v_user_id
       AND activity_date < v_today;

    UPDATE public.learner_profiles
       SET total_xp   = total_xp + v_xp,
           coins      = coins + v_coins,
           streak     = CASE
                          WHEN v_last_date = v_yesterday THEN streak + 1
                          WHEN v_last_date IS NULL        THEN 1
                          ELSE streak
                        END,
           daily_xp   = COALESCE((
                          SELECT SUM(xp_earned) FROM public.daily_activity
                           WHERE user_id = v_user_id AND activity_date = v_today
                        ), 0),
           last_active = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
     WHERE user_id = v_user_id
    RETURNING total_xp, coins, streak INTO v_profile;
  ELSE
    UPDATE public.learner_profiles
       SET coins       = coins + v_coins,
           last_active = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
     WHERE user_id = v_user_id
    RETURNING total_xp, coins, streak INTO v_profile;
  END IF;

  RETURN jsonb_build_object(
    'credited', true,
    'already_claimed', false,
    'total_xp', v_profile.total_xp,
    'coins', v_profile.coins,
    'streak', v_profile.streak
  );
END;
$$;

-- Default EXECUTE goes to PUBLIC, which includes anon. Close that.
REVOKE ALL ON FUNCTION public.award_xp(INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.award_xp(INTEGER, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.award_xp(INTEGER, INTEGER, TEXT, TEXT) TO authenticated;

-- ============================================================================
-- 2. M-9 - the balance columns are server-owned
-- ============================================================================
-- `daily_goal` stays editable because it is a genuine user preference. Every
-- other column is either accumulated by award_xp or derived by it.

REVOKE UPDATE ON public.learner_profiles FROM authenticated;
GRANT UPDATE (daily_goal) ON public.learner_profiles TO authenticated;

-- The client no longer writes these tables at all; only award_xp does. Keeping
-- the policies would leave a path around the atomic increment.
DROP POLICY IF EXISTS "Users can log own XP" ON public.xp_logs;
REVOKE INSERT ON public.xp_logs FROM authenticated, anon;

REVOKE INSERT, UPDATE ON public.daily_activity FROM authenticated, anon;

-- ============================================================================
-- 3. M-2 - the definer-rights views are no longer world-readable
-- ============================================================================
-- Both grants from 20261006_auth_provisioning.sql:201 and :268 are replaced,
-- so re-running that migration's GRANT would have to be beaten by this REVOKE
-- - hence REVOKE first, then GRANT the narrower set.

REVOKE ALL ON public.leaderboard FROM anon;
REVOKE ALL ON public.post_feed FROM anon;
REVOKE ALL ON public.comment_feed FROM anon;

GRANT SELECT ON public.leaderboard TO authenticated;
GRANT SELECT ON public.post_feed, public.comment_feed TO authenticated;

-- ============================================================================
-- 4. M-8 - an actual audit trail
-- ============================================================================
-- The actor is always read from auth.uid(), never from the row being changed:
-- a client-supplied actor is exactly the kind of claim the alpha test flagged.
-- Rows are written by the trigger's own identity, which is why these are
-- SECURITY DEFINER - otherwise the INSERT policy on audit_logs (which now
-- requires is_admin(), see 20261001:56-57) would reject them.

CREATE OR REPLACE FUNCTION public.write_audit_entry(
  p_action        TEXT,
  p_resource_type TEXT,
  p_resource_id   TEXT,
  p_details       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_id UUID := auth.uid();
  v_user_id INTEGER;
BEGIN
  IF v_auth_id IS NULL THEN
    RETURN;  -- service role / cron: no acting user to attribute
  END IF;

  SELECT user_id INTO v_user_id
    FROM public.users
   WHERE supabase_id = v_auth_id::text;

  INSERT INTO public.audit_logs (user_id, action, resource_type, resource_id, details, timestamp)
  VALUES (
    v_user_id,
    p_action,
    p_resource_type,
    p_resource_id,
    p_details,
    now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row    JSONB;
  v_pk     TEXT;
  v_action TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row    := to_jsonb(OLD);
    v_action := lower(TG_TABLE_NAME) || '.delete';
  ELSE
    v_row    := to_jsonb(NEW);
    v_action := lower(TG_TABLE_NAME)
             || CASE WHEN TG_OP = 'INSERT' THEN '.create' ELSE '.update' END;
  END IF;

  -- Read the primary key out of a JSONB view of the row rather than off the row
  -- itself. `v_row.post_id` on a RECORD assigned from NEW resolves against
  -- NEW's exact composite type, so a table without that column - `preserved_words`
  -- has no `post_id` - raises "record has no field" and aborts the triggering
  -- INSERT. `to_jsonb` returns NULL for an absent key instead, which is what
  -- makes one trigger function safe across all four tables.
  v_pk := COALESCE(
    v_row ->> 'post_id',
    v_row ->> 'comment_id',
    v_row ->> 'word_id',
    v_row ->> 'request_id',
    v_row ->> 'id'
  );

  PERFORM public.write_audit_entry(v_action, TG_TABLE_NAME, v_pk, NULL);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_community_posts ON public.community_posts;
CREATE TRIGGER audit_community_posts
  AFTER INSERT OR UPDATE OR DELETE ON public.community_posts
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS audit_comments ON public.comments;
CREATE TRIGGER audit_comments
  AFTER INSERT OR UPDATE OR DELETE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS audit_preserved_words ON public.preserved_words;
CREATE TRIGGER audit_preserved_words
  AFTER INSERT OR UPDATE OR DELETE ON public.preserved_words
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

-- A dedicated action for XP so an inflated balance is visible in the trail as
-- its own fact, not as an unexplained total.
CREATE OR REPLACE FUNCTION public.audit_xp_award()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.write_audit_entry(
    'xp.award',
    'xp_logs',
    NEW.id::text,
    format('amount=%s source=%s', NEW.amount, NEW.source)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_xp_award ON public.xp_logs;
CREATE TRIGGER audit_xp_award
  AFTER INSERT ON public.xp_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_xp_award();

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- BEGIN 20261007140000_seed_avatar_catalogue.sql
-- ============================================================================
-- SultiAI: make the avatar catalogue match the app's six bundled avatars.
--
-- Finding M-10, found while closing M-9.
--
-- `public.users.avatar_id` and `public.avatars.avatar_id` are INTEGER, and the
-- only row ever seeded was avatar_id = 1 ('Default'). The app, meanwhile, has six
-- avatars keyed by string - 'avatar-01' ... 'avatar-06' in
-- `src/constants/avatars.js` - and those ids are what the picker passes around.
--
-- Two consequences:
--
--   1. Writing one through `api.updateProfile({ avatar_id: 'avatar-03' })` sends a
--      string into an INTEGER column, which PostgREST rejects. Nothing on screen
--      ever hit this because `ProfileScreen.handleAvatarSelect` only wrote to
--      AsyncStorage and never called the API at all - so the selection never left
--      the device. A new device, or the web build, started from the default again.
--   2. Even a correct lookup missed: `api.getProfile` and the `leaderboard` view
--      join `avatars a ON a.avatar_id = u.avatar_id`, and only id 1 existed, so
--      every user rendered as the shared default avatar.
--
-- The bundled PNGs stay the source of truth for rendering in-app
-- (`getAvatarSource` resolves them from the bundle). This table exists so the
-- server can resolve the same six choices to a stable image for the community
-- feed and the leaderboard, where there is no bundle to read from.

-- `avatar_image` is a URL: `src/components/Avatar.js` renders it with
-- `<Image source={{ uri }} />` and falls back to initials on load error, so a
-- DiceBear URL matches the contract the default row already established.
INSERT INTO public.avatars (avatar_id, avatar_name, avatar_image) VALUES
  (1, 'Short dark hair',  'https://api.dicebear.com/7.x/avataaars/svg?seed=sulti-avatar-01'),
  (2, 'Long dark hair',   'https://api.dicebear.com/7.x/avataaars/svg?seed=sulti-avatar-02'),
  (3, 'Curly hair',       'https://api.dicebear.com/7.x/avataaars/svg?seed=sulti-avatar-03'),
  (4, 'Medium hair',      'https://api.dicebear.com/7.x/avataaars/svg?seed=sulti-avatar-04'),
  (5, 'Glasses',          'https://api.dicebear.com/7.x/avataaars/svg?seed=sulti-avatar-05'),
  (6, 'Different style',  'https://api.dicebear.com/7.x/avataaars/svg?seed=sulti-avatar-06')
ON CONFLICT (avatar_id) DO UPDATE
  SET avatar_name = EXCLUDED.avatar_name,
      avatar_image = EXCLUDED.avatar_image;

-- Rows beyond 6 are not reachable from the app's picker. Removing them would be
-- destructive if an operator added some on purpose, so they are left alone -
-- but users.avatar_id is clamped below so nothing can point at a missing row.
DO $$
DECLARE
  stale RECORD;
BEGIN
  FOR stale IN
    SELECT user_id, avatar_id FROM public.users
     WHERE avatar_id IS NOT NULL AND avatar_id NOT BETWEEN 1 AND 6
  LOOP
    RAISE NOTICE 'users.user_id=% has out-of-range avatar_id %, reset to 1',
      stale.user_id, stale.avatar_id;
    UPDATE public.users SET avatar_id = 1 WHERE user_id = stale.user_id;
  END LOOP;
END $$;

-- NULL is a legitimate "not chosen yet" state and resolves to the default at
-- read time; leave it alone rather than coercing it here.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_avatar_id_range;
ALTER TABLE public.users
  ADD CONSTRAINT users_avatar_id_range
  CHECK (avatar_id IS NULL OR avatar_id BETWEEN 1 AND 6);

-- ============================================================================
-- BEGIN 20261007150000_verification_audio_bucket.sql
-- ============================================================================
-- SultiAI: give native-speaker verification somewhere to put the audio.
--
-- Finding m-4 from the alpha test.
--
-- `api.submitVerification(audioBase64, phraseId)` accepted the recording and then
-- threw it away, writing the literal string 'inline_base64' into
-- `verification_requests.audio_path` (see the git history for
-- src/services/api.js). The request row was created and the UI reported success,
-- so a learner who spent a minute recording a phrase was told it had been sent
-- for verification when no audio existed anywhere. `getVerificationRequests`
-- then hands moderators a list whose `audio_path` cannot be used to listen to
-- anything - so the whole verification workflow was inert.
--
-- This creates the private bucket the client needs. It does NOT create the
-- upload call: that lands with the client change below, which cannot be verified
-- from this repository alone.
--
-- Security model:
--
--   * Private bucket. No public URL - a pronunciation recording is the user's own
--     voice and is not something to serve to anyone holding the anon key.
--   * Path convention `{user_id}/{request_id}.webm`, so ownership is checkable
--     from the path without a second lookup, and so a moderator can be granted
--     read on the whole bucket by role without enumerating user folders.
--   * Writes are restricted to the caller's own folder by the first path segment
--     being their own `users.user_id`. That check is written as an EXISTS
--     against `public.users` rather than trusting a folder name, and it resolves
--     the caller from `auth.uid()`.
--   * Object names are sanitised so a caller cannot write outside their folder
--     with a `../` segment.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'verification-audio',
  'verification-audio',
  false,
  10485760, -- 10 MB, comfortably above a spoken phrase
  ARRAY['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- `private` is the security-defining column; `public` is only what
-- `get_public_url` keys off. Both are set above so neither the file listing nor
-- a share link can leak the object.

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- Dropped first: CREATE POLICY would otherwise collide with a same-named policy
-- from an earlier attempt at this feature.

DROP POLICY IF EXISTS "Users upload own verification audio" ON storage.objects;
DROP POLICY IF EXISTS "Users read own verification audio" ON storage.objects;
DROP POLICY IF EXISTS "Moderators read all verification audio" ON storage.objects;

-- The caller's own folder. `{user_id}` is the first path segment, so this is a
-- prefix match rather than an equality check.
CREATE POLICY "Users upload own verification audio" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'verification-audio'
    AND (storage.foldername(name))[1] IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.users u
       WHERE u.user_id::text = (storage.foldername(name))[1]
         AND u.supabase_id = auth.uid()::text
    )
  );

-- A learner may play back their own submission.
CREATE POLICY "Users read own verification audio" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'verification-audio'
    AND EXISTS (
      SELECT 1
        FROM public.users u
       WHERE u.user_id::text = (storage.foldername(name))[1]
         AND u.supabase_id = auth.uid()::text
    )
  );

-- Moderators and admins read the whole bucket, which is the point of the
-- workflow. The same check the table policies use, so the two cannot drift.
CREATE POLICY "Moderators read all verification audio" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'verification-audio'
    AND public.is_moderator_or_admin()
  );

-- No DELETE or UPDATE policy is created. Nothing in the app needs them, and an
-- object a learner cannot withdraw is a small privacy cost for a small
-- simplification - see the Residual Risks section of docs/ALPHA_EVALUATION.md.

-- ============================================================================
-- BEGIN 20261013120000_admin_console_supabase.sql
-- ============================================================================
-- SultiAI: support the admin console talking to Supabase only.
--
-- The admin console used to read/write an Express backend (server/) that owned
-- a MySQL database. Both are retired. This migration lands the two things the
-- console needs to run entirely on Supabase:
--
--   1. The handful of columns the console renders that the app schema never
--      grew (they existed only in the MySQL schema): a user bio, post/module
--      visibility flags, a feedback comment, and preserved-word variations.
--   2. A service-role escape hatch on `guard_users_privileged_columns`, so the
--      server-only admin routes can perform administrator writes (role, status,
--      verification) without an end-user JWT in the request.
--
-- Why (2) is not a hole: the admin console's Next.js route handlers talk to
-- PostgREST with `SUPABASE_SECRET_KEY`, which never reaches the browser. Before
-- any such write runs, the handler calls `auth.getUser(token)` on the caller's
-- Supabase access token and refuses unless that user's `public.users.role` is
-- 'admin'. `auth.role()` reads the JWT that Supabase actually minted for the
-- request, so it cannot be spoofed by a client. This mirrors the precedent in
-- `20261001_gamification_integrity.sql`, whose audit_logs INSERT policy already
-- trusts `auth.role() = 'service_role'`.

-- ============================================================================
-- 1. Columns the admin console renders
-- ============================================================================
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS bio TEXT;

ALTER TABLE public.community_posts
  ADD COLUMN IF NOT EXISTS is_hidden INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.feedback
  ADD COLUMN IF NOT EXISTS comment TEXT;

ALTER TABLE public.learning_modules
  ADD COLUMN IF NOT EXISTS is_published INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.learning_modules
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE public.preserved_words
  ADD COLUMN IF NOT EXISTS variations TEXT[] NOT NULL DEFAULT '{}';

-- Keep `learning_modules.updated_at` honest, matching every other table that
-- carries the column.
DROP TRIGGER IF EXISTS update_learning_modules_updated_at ON public.learning_modules;
CREATE TRIGGER update_learning_modules_updated_at
  BEFORE UPDATE ON public.learning_modules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================================
-- 2. Service role may clear the privileged-column guard
-- ============================================================================
-- Reissued from 20261007120000_harden_role_and_rls_policies.sql:171-213 with a
-- single added clause. Everything else - the password_hash, supabase_id and
-- primary-key guards - is unchanged.
CREATE OR REPLACE FUNCTION public.guard_users_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Two ways through: a real administrator JWT (is_admin(), which reads the
  -- pre-update row), or the server-only service role whose caller was already
  -- verified as an admin by the Next.js route handler.
  IF COALESCE(is_admin(), false) OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Only an administrator can change a user role.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    RAISE EXCEPTION 'Password hashes are managed by Supabase Auth.'
      USING ERRCODE = '42501';
  END IF;

  -- Rebinding the row to a different auth identity is account takeover.
  IF NEW.supabase_id IS DISTINCT FROM OLD.supabase_id THEN
    RAISE EXCEPTION 'The linked auth identity cannot be changed from the client.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'The primary key cannot be changed.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.is_verified IS DISTINCT FROM OLD.is_verified
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.role_id IS DISTINCT FROM OLD.role_id THEN
    RAISE EXCEPTION 'Verification, status and role mapping are administrator-only.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
