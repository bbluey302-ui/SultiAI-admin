-- SultiAI: make `auth.users` <-> `public.users` a real, cascade-linked pair and
-- enable Realtime on `public.users`.
--
-- Problem this closes
-- ---------------------
-- `public.users.supabase_id` is a TEXT column with NO foreign key to
-- `auth.users`. Provisioning a user in auth.users fires the
-- `handle_new_auth_user` trigger, which inserts a `public.users` row (that
-- direction works). But deleting a user from `auth.users` left the
-- `public.users` row behind as an orphan the console kept showing, because
-- nothing cascaded. The console's own delete path (public.users first, then
-- auth.users) is unaffected, but an external delete from the SQL editor or
-- the Supabase dashboard silently desynchronised the two.
--
-- Why not just convert `supabase_id` to UUID
-- ------------------------------------------
-- Dozens of RLS policies and triggers match on `supabase_id = auth.uid()::text`
-- (20260904_fix_rls_policies.sql, 20261006_auth_provisioning.sql,
-- 20261007120000, 20261007130000, 20261007150000). Retyping the column would
-- force every one of them to be reissued in the same breath. Instead we add a
-- dedicated ownership link, `auth_uuid UUID`, that carries the cascade, and
-- leave the text mirror in place for the RLS layer. The trigger below keeps
-- both in sync for every new user.

-- 1. The ownership column.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS auth_uuid UUID;

-- 2. Backfill from the text mirror. Only well-formed UUIDs are copied, so a
--    legacy row with a NULL/garbage supabase_id stays NULL (no cascade) rather
--    than failing the migration. Verified against the live database: every
--    existing supabase_id is a real auth.users id.
UPDATE public.users
   SET auth_uuid = supabase_id::uuid
 WHERE supabase_id IS NOT NULL
   AND supabase_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

-- 3. The cascade. Removing the auth identity removes the console-visible row
--    with it, atomically and without any application code.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_auth_uuid_fkey' AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_auth_uuid_fkey
      FOREIGN KEY (auth_uuid) REFERENCES auth.users(id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- 4. New auth users carry the link from the moment they are provisioned.
--    Identical to 20261007120000_harden_role_and_rls_policies.sql:89-140 except
--    for the `auth_uuid` column and its `NEW.id` value.
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
  --
  -- auth_uuid is set from NEW.id so the cascade FK is satisfied at creation
  -- time and a later delete of the auth identity removes this row.
  INSERT INTO public.users (fullname, email, password_hash, supabase_id, auth_uuid, role, preferred_lang, learning_lang, country)
  VALUES (v_fullname, NEW.email, 'supabase-managed', NEW.id::text, NEW.id,
          'user',
          v_native_lang, v_target_lang, v_country)
  ON CONFLICT (supabase_id) DO UPDATE
    SET fullname      = COALESCE(NULLIF(EXCLUDED.fullname, ''), public.users.fullname),
        preferred_lang = COALESCE(NULLIF(EXCLUDED.preferred_lang, ''), public.users.preferred_lang),
        learning_lang  = COALESCE(NULLIF(EXCLUDED.learning_lang, ''), public.users.learning_lang),
        country        = COALESCE(NULLIF(EXCLUDED.country, ''), public.users.country),
        auth_uuid      = COALESCE(public.users.auth_uuid, EXCLUDED.auth_uuid)
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

-- 5. Realtime: broadcast `public.users` changes so the console updates live
--    instead of waiting for a manual refresh. Guarded so the migration is
--    idempotent (adding a table already present would otherwise error).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
