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
