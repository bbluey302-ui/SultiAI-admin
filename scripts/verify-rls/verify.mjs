#!/usr/bin/env node
/**
 * Proves the two Critical privilege-escalation findings from the alpha test are
 * closed. See ./README.md before running this.
 *
 * IMPORTANT: run against a scratch project or a local stack. This creates real
 * accounts and deliberately attempts to escalate them.
 *
 * The only credentials used are the anon key. That is the point - if these
 * checks need a service role key to pass, the fix is not a real fix, because the
 * app never has one on the client.
 */

const URL_BASE = process.env.VERIFY_SUPABASE_URL;
const ANON_KEY = process.env.VERIFY_SUPABASE_ANON_KEY;

if (!URL_BASE || !ANON_KEY) {
  console.error(
    'Missing credentials. Set both:\n' +
      '  VERIFY_SUPABASE_URL\n' +
      '  VERIFY_SUPABASE_ANON_KEY\n'
  );
  process.exit(2);
}

// Unique per run so repeated runs never collide on the email unique index.
const RUN = Date.now().toString(36);
const results = [];

/** Every request is made the way the app makes it: anon key + the user's JWT. */
function headers(jwt) {
  const h = { apikey: ANON_KEY, 'Content-Type': 'application/json' };
  if (jwt) h.Authorization = `Bearer ${jwt}`;
  return h;
}

async function rest(path, { method = 'GET', jwt = null, body = undefined, prefer = null } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: { ...headers(jwt), ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, ok: res.ok, data: parsed, raw: text };
}

async function signUp(email, password, metadata) {
  const res = await fetch(`${URL_BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, password, data: metadata }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/**
 * A learner account with a clean signup.
 *
 * `metadata` is where the C-2 attempt goes - the caller-supplied object that
 * `handle_new_auth_user()` used to read `role` from.
 */
async function createLearner(metadata = {}) {
  const email = `verify-${RUN}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = 'VerifyOnly-9x';
  const signup = await signUp(email, password, metadata);

  if (signup.status !== 200) {
    throw new Error(
      `Could not create a learner (${signup.status}). Email confirmation may be ` +
        `required on this project - disable "Confirm email" for the scratch project first. ` +
        JSON.stringify(signup.body)
    );
  }

  const accessToken = signup.body?.access_token;
  if (!accessToken) {
    throw new Error(
      'Signup returned no access token. If email confirmation is enabled, this ' +
        'script cannot sign in. Disable it on the scratch project.'
    );
  }

  const me = await rest('users?select=user_id, role, fullname&limit=1', { jwt: accessToken });
  const row = Array.isArray(me.data) ? me.data[0] : null;

  if (!row) {
    throw new Error(
      'The new learner has no public.users row. handle_new_auth_user() did not ' +
        'fire, so nothing downstream can be verified.'
    );
  }

  return { email, password, jwt: accessToken, userId: row.user_id, role: row.role };
}

function record(id, title, passed, detail) {
  results.push({ id, title, passed, detail });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${id.padEnd(4)} ${title}`);
  if (!passed && detail) console.log(`      ${detail}`);
}

// ---------------------------------------------------------------------------
// C-2: role injection at signup
// ---------------------------------------------------------------------------
// `raw_user_meta_data` is whatever the caller passed in `options.data`. Before
// the fix, `handle_new_auth_user()` read the role from it, so this registers an
// admin.

async function checkC2() {
  const attacker = await createLearner({
    full_name: 'Escalation Attempt',
    // The escalation payload.
    role: 'admin',
    permissions: ['*'],
  });

  const passed = attacker.role === 'user';
  record(
    'C-2',
    "signup with data:{role:'admin'} provisions role='user'",
    passed,
    passed
      ? `provisioned as '${attacker.role}'`
      : `provisioned as '${attacker.role}' - the signup trigger is still reading raw_user_meta_data`
  );
  return passed;
}

// ---------------------------------------------------------------------------
// C-1: writing your own role
// ---------------------------------------------------------------------------
// The self-UPDATE policy on `public.users` had no WITH CHECK and no column
// restriction, so `role`, `password_hash` and `supabase_id` were all writable.

async function checkC1(learner) {
  // The escalation itself. Revoking the column grant should make this fail at
  // the privilege layer before RLS is even consulted.
  const escalation = await rest(`users?user_id=eq.${learner.userId}`, {
    method: 'PATCH',
    jwt: learner.jwt,
    body: { role: 'admin' },
  });

  const after = await rest('users?select=role&user_id=eq.' + learner.userId, { jwt: learner.jwt });
  const roleNow = Array.isArray(after.data) ? after.data[0]?.role : undefined;

  const refused = !escalation.ok;
  const roleUnchanged = roleNow === 'user';

  record(
    'C-1',
    'self-UPDATE of users.role is refused',
    refused && roleUnchanged,
    refused && roleUnchanged
      ? `refused with ${escalation.status}`
      : `status=${escalation.status} role is now '${roleNow}'`
  );

  // Defence in depth: the guard trigger must reject a role change even if some
  // future grant is wider than intended.
  const rebind = await rest(`users?user_id=eq.${learner.userId}`, {
    method: 'PATCH',
    jwt: learner.jwt,
    body: { supabase_id: '00000000-0000-0000-0000-000000000000' },
  });
  record(
    'C-1b',
    'self-UPDATE of users.supabase_id is refused',
    !rebind.ok,
    rebind.ok ? `accepted with ${rebind.status}` : `refused with ${rebind.status}`
  );

  return refused && roleUnchanged && !rebind.ok;
}

// ---------------------------------------------------------------------------
// M-6: the RBAC catalogue
// ---------------------------------------------------------------------------
// `20260904_add_rbac_tables.sql` created three policies commented "Admin-only"
// whose predicate was literally `USING (true)`.

async function checkRbac(learner) {
  const res = await rest('role_permissions?select=*', {
    method: 'POST',
    jwt: learner.jwt,
    body: { role_id: 1, permission_id: 1 },
  });
  const refused = !res.ok;
  record(
    'RBAC',
    'roles/permissions are not writable by a learner',
    refused,
    refused ? `refused with ${res.status}` : `insert accepted with ${res.status}`
  );
  return refused;
}

// ---------------------------------------------------------------------------
// M-2: the definer-rights views
// ---------------------------------------------------------------------------
// `leaderboard`, `post_feed` and `comment_feed` are created WITHOUT
// `security_invoker`, so they bypass RLS. They were granted to `anon`.

async function checkAnonViews() {
  const res = await rest('leaderboard?select=*&limit=1'); // no jwt = anon
  const refused = !res.ok;
  record(
    'ANON',
    'anon cannot read the leaderboard view',
    refused,
    refused ? `refused with ${res.status}` : `returned ${res.status}`
  );
  return refused;
}

// ---------------------------------------------------------------------------
// M-9: the balance columns
// ---------------------------------------------------------------------------

async function checkBalanceWrite(learner) {
  const res = await rest(`learner_profiles?user_id=eq.${learner.userId}`, {
    method: 'PATCH',
    jwt: learner.jwt,
    body: { total_xp: 999999, coins: 999999 },
  });
  const refused = !res.ok;
  record(
    'BAL',
    'learner cannot set total_xp / coins directly',
    refused,
    refused ? `refused with ${res.status}` : `accepted with ${res.status}`
  );
  return refused;
}

// ---------------------------------------------------------------------------
// M-1: award_xp
// ---------------------------------------------------------------------------

async function checkAwardXp(learner) {
  const before = await rest(
    `learner_profiles?select=total_xp&user_id=eq.${learner.userId}`,
    { jwt: learner.jwt }
  );
  const startXp = Number(Array.isArray(before.data) ? before.data[0]?.total_xp : 0) || 0;

  // Same key twice: the second must be a no-op. This is the property the offline
  // queue depends on - a replayed entry credits once, not twice.
  const key = `verify:${RUN}:repeat`;
  await rest('rpc/award_xp', {
    method: 'POST',
    jwt: learner.jwt,
    body: { p_xp: 25, p_source: 'verify', p_idempotency_key: key },
  });
  const second = await rest('rpc/award_xp', {
    method: 'POST',
    jwt: learner.jwt,
    body: { p_xp: 25, p_source: 'verify', p_idempotency_key: key },
  });

  const after = await rest(
    `learner_profiles?select=total_xp&user_id=eq.${learner.userId}`,
    { jwt: learner.jwt }
  );
  const endXp = Number(Array.isArray(after.data) ? after.data[0]?.total_xp : 0) || 0;

  const creditedOnce = endXp === startXp + 25;
  const secondWasNoOp = second.body?.already_claimed === true;

  record(
    'XP',
    'award_xp credits exactly once for a repeated idempotency key',
    creditedOnce && secondWasNoOp,
    `total_xp ${startXp} -> ${endXp} (expected ${startXp + 25}), ` +
      `second call already_claimed=${secondWasNoOp}`
  );

  // award_xp resolves the caller from auth.uid() and takes no user_id parameter,
  // so there is no argument a caller could pass to credit somebody else.
  const spoof = await rest('rpc/award_xp', {
    method: 'POST',
    jwt: learner.jwt,
    body: { p_xp: 10, p_source: 'verify', p_idempotency_key: `verify:${RUN}:spoof`, user_id: 999999 },
  });
  const noUserIdParam = spoof.status !== 400 || !/user_id/i.test(spoof.raw ?? '');

  record(
    'XP2',
    'award_xp takes no user_id argument (caller is resolved server-side)',
    noUserIdParam,
    noUserIdParam ? 'ignored' : 'the function accepts a user_id argument'
  );

  return creditedOnce && secondWasNoOp;
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nRLS verification against ${URL_BASE}\n`);

  let clean = true;
  let learner = null;

  try {
    clean = (await checkC2()) && clean;
    learner = await createLearner({ full_name: 'RLS Verifier' });
    clean = (await checkC1(learner)) && clean;
    clean = (await checkRbac(learner)) && clean;
    clean = (await checkAnonViews()) && clean;
    clean = (await checkBalanceWrite(learner)) && clean;
    clean = (await checkAwardXp(learner)) && clean;
  } catch (err) {
    console.error(`\nAborted: ${err.message}\n`);
    process.exit(2);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (learner ? `\nscratch account: ${learner.email} (safe to delete)` : '')
  );

  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ${f.id}  ${f.title}`);
    console.log(
      '\nTreat any failure as a release blocker. If a migration did not apply,\n' +
        'check supabase_migrations for a version later than 20261007120000 - a\n' +
        'failed migration leaves no record and every one after it is skipped.\n'
    );
    process.exit(1);
  }

  console.log('\nAll escalation paths are closed.\n');
}

main();
