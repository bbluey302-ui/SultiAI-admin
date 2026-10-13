-- SultiAI: platform_settings is administrative configuration, not public
-- configuration.
--
-- Finding: `20260904_fix_rls_policies.sql:507-508` created
--   "Authenticated users can read platform settings"
--   FOR SELECT USING (auth.role() = 'authenticated')
-- so any signed-in learner could read the admin console's persisted settings
-- JSON (maintenance mode, signup toggle, community toggle, daily XP goal, max
-- daily AI requests, AI provider choice).
--
-- The write path was already `is_admin()` only ("Admins can manage platform
-- settings", :504-505), so the exposure was read-only -- but it is still
-- administrative configuration, and the learner app and web app never read this
-- table at all (verified: the only readers are the admin console, which uses the
-- RLS-bypassing service-role client). Nothing depends on the broad grant.
--
-- Fix: restrict the read to administrators, matching the write path.

DROP POLICY IF EXISTS "Authenticated users can read platform settings"
  ON public.platform_settings;

CREATE POLICY "Admins can read platform settings"
  ON public.platform_settings
  FOR SELECT USING (is_admin());

NOTIFY pgrst, 'reload schema';
