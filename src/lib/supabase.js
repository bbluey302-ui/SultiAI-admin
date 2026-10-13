import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[Supabase] Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY');
}

export { SUPABASE_URL, SUPABASE_ANON_KEY };

export const supabase = createClient(SUPABASE_URL || '', SUPABASE_ANON_KEY || '', {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});

export function normalizeUser(supabaseUser) {
  if (!supabaseUser) return null;
  const meta = supabaseUser.user_metadata || {};
  return {
    id: supabaseUser.id,
    email: supabaseUser.email,
    fullname: meta.full_name || meta.fullname || '',
    name: meta.full_name || meta.fullname || '',
    native_language: meta.native_language || 'English',
    target_language: meta.target_language || 'Bisaya',
    country: meta.country || '',
    avatar: meta.avatar_url || meta.avatar || '',
    avatar_id: meta.avatar_id || 'avatar-01',
    // NOT from user_metadata. That object is caller-supplied at signup, so a
    // `role` key in it is a claim the user made about themselves, and the app
    // gates UI on `user.role` (see RoleGuard / UserContext.isAdmin). The real
    // role is read from `public.users.role` via `refreshRoleFromDb` and
    // applied on top of this object by UserContext.
    //
    // `permissions` is likewise absent: the role/permission catalogue in
    // `20260904_add_rbac_tables.sql` is admin-only under RLS, so the mobile
    // client has no server-side source for a per-user permission list yet.
    // `hasPermission` therefore admits admins only, which fails closed.
    role: 'user',
    permissions: [],
  };
}
