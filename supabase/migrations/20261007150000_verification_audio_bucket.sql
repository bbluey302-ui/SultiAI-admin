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
