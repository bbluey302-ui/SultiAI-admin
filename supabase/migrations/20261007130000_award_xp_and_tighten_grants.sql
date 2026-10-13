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