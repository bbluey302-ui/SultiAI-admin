# SultiAI: apply the repo's Supabase migrations to a remote project that was
# provisioned by the old Express server (no supabase_migrations history exists
# remotely, so `supabase db push` would try to re-run the base schema and fail).
#
# Usage:
#   .\scripts\apply-db-migrations.ps1 -ProjectRef <ref> -Token <mgmt-api-token>
#
# Notes:
#   * 20260827073100_new-migration.sql (base schema) is skipped: the tables
#     already exist remotely and were created by the legacy server.
#   * A UNIQUE index on public.users(supabase_id) is added first — the
#     provisioning backfill in 20261006 does `ON CONFLICT (supabase_id)`.
#   * Each migration is posted to the Management API SQL endpoint (multi-
#     statement scripts are supported; the endpoint returns the last result).
#   * Aborts if a migration returns an error so bad SQL never goes unnoticed.

param(
  [Parameter(Mandatory = $true)][string]$ProjectRef,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$MigrationsDir = "supabase/migrations"
)

$ErrorActionPreference = 'Stop'

function Invoke-DbQuery {
  param([string]$Query, [string]$Label)
  $body = @{ query = $Query } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" `
      -Headers @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' } `
      -Method POST -Body $body -TimeoutSec 120
    Write-Host "[OK]   $Label"
    return $resp
  } catch {
    $detail = $_.ErrorDetails.Message
    if (-not $detail) { $detail = $_.Exception.Message }
    Write-Host "[FAIL] $Label" -ForegroundColor Red
    Write-Host "       $detail" -ForegroundColor Red
    throw
  }
}

function Invoke-MigrationFile {
  param([string]$Path)
  $raw = Get-Content -Path $Path -Raw
  Invoke-DbQuery -Query $raw -Label "migration: $(Split-Path $Path -Leaf)"
}

$ErrorActionPreference = 'Continue'  # we handle failures per step

# ---------------------------------------------------------------------------
# 0. Pre-flight: unique index on users.supabase_id
# ---------------------------------------------------------------------------
Write-Host "=== Step 0: users.supabase_id unique index ==="
$dupes = Invoke-DbQuery -Query @"
SELECT supabase_id, count(*) AS n FROM public.users
GROUP BY supabase_id HAVING count(*) > 1;
"@ -Label "check for duplicate supabase_id"
if ($dupes -and $dupes.n) {
  Write-Host "[ABORT] duplicate supabase_id values found:" -ForegroundColor Red
  $dupes | Format-Table -AutoSize
  exit 1
}
Invoke-DbQuery -Query @"
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_id
  ON public.users(supabase_id);
"@ -Label "create idx_users_supabase_id"

# ---------------------------------------------------------------------------
# 0b. Base-schema columns the legacy server never created.
#     The base migration (20260827073100) is skipped, but 20260904_fix_rls_policies
#     and 20261007120000 both reference public.users.status, so it must exist
#     before they run. `bio` is added by 20261013120000 (idempotent).
# ---------------------------------------------------------------------------
Invoke-DbQuery -Query @"
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_users_status ON public.users(status);
"@ -Label "add users.status"

# 20260904_add_rbac_tables.sql has already run, and its three USING(true)
# policies are not idempotent; drop them so its CREATE POLICY does not collide.
# 20260904_fix_rls_policies.sql drops qual='true' policies again immediately after.
Invoke-DbQuery -Query @"
DROP POLICY IF EXISTS "Admins can manage roles" ON public.roles;
DROP POLICY IF EXISTS "Admins can manage permissions" ON public.permissions;
DROP POLICY IF EXISTS "Admins can manage role permissions" ON public.role_permissions;
"@ -Label "drop legacy RBAC policies"

# ---------------------------------------------------------------------------
# Migrations, in repo order (base-schema 20260827 skipped — tables exist)
# ---------------------------------------------------------------------------
$order = @(
  '20260904_add_rbac_tables.sql',
  '20260904_fix_rls_policies.sql',
  '20260926_learning_path_integration.sql',
  '20261001_gamification_integrity.sql',
  '20261006_auth_provisioning.sql',
  '20261007120000_harden_role_and_rls_policies.sql',
  '20261007130000_award_xp_and_tighten_grants.sql',
  '20261007140000_seed_avatar_catalogue.sql',
  '20261007150000_verification_audio_bucket.sql',
  '20261013120000_admin_console_supabase.sql'
)

foreach ($name in $order) {
  $path = Join-Path $MigrationsDir $name
  if (-not (Test-Path $path)) {
    Write-Host "[SKIP] missing $name" -ForegroundColor Yellow
    continue
  }
  Write-Host "--- $name ---"
  try {
    $result = Invoke-MigrationFile -Path $path
    if ($result -is [System.Array]) {
      Write-Host "[OK]   returned rows: $($result.Count)"
    } elseif ($null -ne $result) {
      Write-Host "[OK]   returned: $($result | ConvertTo-Json -Compress)"
    }
  } catch {
    Write-Host "[ABORT] migration $name failed; stopping." -ForegroundColor Red
    exit 1
  }
}

# ---------------------------------------------------------------------------
# Post-flight verification
# ---------------------------------------------------------------------------
Write-Host "`n=== Post-flight verification ==="
try {
  $v1 = Invoke-DbQuery -Query @"
select
  (select count(*) from auth.users) as auth_users,
  (select count(*) from public.users) as pub_users,
  (select count(*) from public.user_settings) as settings,
  (select count(*) from public.learner_profiles) as profiles,
  (select count(*) from pg_policies where schemaname='public') as policies;
"@ -Label "row + policy counts"
  $v1 | Format-List | Out-String | Write-Host

  $v2 = Invoke-DbQuery -Query @"
select to_regprocedure('public.get_user_id()') as get_user_id,
       to_regprocedure('public.is_admin()') as is_admin,
       to_regprocedure('public.award_xp(integer,integer,text,text)') as award_xp,
       to_regclass('public.leaderboard') as leaderboard,
       to_regclass('public.post_feed') as post_feed;
"@ -Label "helpers + views"
  $v2 | Format-List | Out-String | Write-Host

  $v3 = Invoke-DbQuery -Query @"
select r.rolname, has_function_privilege(r.rolname, 'public.award_xp(integer,integer,text,text)', 'EXECUTE') as can_exec_award_xp
from pg_roles r where r.rolname in ('anon','authenticated') order by r.rolname;
"@ -Label "award_xp grants"
  $v3 | Format-Table -AutoSize | Out-String | Write-Host

  $v4 = Invoke-DbQuery -Query @"
select u.user_id, u.email, u.role from public.users u where u.role <> 'user' order by u.user_id;
"@ -Label "non-learner roles (review if unexpected)"
  $v4 | Format-Table -AutoSize | Out-String | Write-Host
} catch {
  Write-Host "[WARN] verification query failed: $_" -ForegroundColor Yellow
}

Write-Host "`nDone." -ForegroundColor Green