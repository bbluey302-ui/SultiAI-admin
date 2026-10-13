# RLS verification harness

Throwaway scripts that prove - or disprove - that the two Critical findings from
the alpha test are actually closed. Run them against a **scratch** Supabase
project or a local stack, never production: they create real accounts and attempt
real privilege escalation.

## What is being verified

| ID | Finding | Question |
|----|---------|----------|
| C-1 | Any user could set their own `public.users.role` to `'admin'` | Can a signed-up learner promote themselves? |
| C-2 | Signup derived the role from `raw_user_meta_data`, which the caller controls | Can a learner register as an admin? |

Both are closed by `supabase/migrations/20261007120000_harden_role_and_rls_policies.sql`.

## Setup

```powershell
# Point at a SCRATCH project. The anon key is all that is needed - no service
# role key, because these tests must prove the fix from the client side.
$env:VERIFY_SUPABASE_URL = "https://<scratch-ref>.supabase.co"
$env:VERIFY_SUPABASE_ANON_KEY = "<scratch-anon-key>"

# Apply every migration.
supabase db push
```

## Run

```powershell
node scripts/verify-rls/verify.mjs
```

Exit code `0` means every check passed. Any non-zero exit means at least one
escalation path is still open - treat that as a release blocker, not a warning.

The script prints a pass/fail line per check and, on failure, the HTTP status and
response body from PostgREST, which is usually enough to identify which policy
let it through.

## Why this exists as a script and not a test

The alpha test scored "security" from reading policies, which cannot distinguish
a policy that reads correctly from one that behaves correctly. A `USING (true)`
policy commented "Admin-only" sat in `20260904_add_rbac_tables.sql` and passed
that review. Only executing the attempt proves the boundary.

## Expected results after the fix

```
PASS  C-2  signup with data:{role:'admin'} provisions role='user'
PASS  C-1  self-UPDATE of users.role is refused
PASS  C-1b self-UPDATE of users.supabase_id is refused
PASS  RBAC roles/permissions are not writable by a learner
PASS  anon cannot read the leaderboard view
PASS  learner cannot set total_xp on learner_profiles
PASS  award_xp credits exactly once for a repeated idempotency key
PASS  award_xp credits the caller only (user_id is not a parameter)
```

If any line reads `FAIL`, the migration did not apply or did not apply cleanly.
Check `supabase_migrations` for a version later than `20261007120000` - a failed
migration leaves no record and everything after it is skipped.
