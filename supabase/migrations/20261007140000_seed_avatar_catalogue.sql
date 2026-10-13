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