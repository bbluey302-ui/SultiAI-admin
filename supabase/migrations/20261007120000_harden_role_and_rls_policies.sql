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