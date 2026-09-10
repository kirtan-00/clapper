// One-off: apply the email_sends migration via the Supabase Management API
// (the sbp token in credentials.md), no DB password needed. Same transport the
// seed script uses. Run from the project root:
//
//   node scripts/apply-email-sends.mjs
//
// Then load the real sends:
//
//   node scripts/seed-email-sends.mjs --run
//
// Reads the sbp token inside this script and never prints it — prints only the
// apply result and a table-exists check.
import { readFileSync } from 'node:fs';

const sbp = (readFileSync('credentials.md', 'utf8').match(/sbp_[A-Za-z0-9]+/) || [])[0];
if (!sbp) { console.error('No sbp_ token found in credentials.md'); process.exit(1); }
const REF = 'sqqdivfgdfaztfzrzkhu';
const sql = readFileSync('supabase/migrations/20260831120000_email_sends.sql', 'utf8');

async function q(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sbp}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: r.status, text: await r.text() };
}

const applied = await q(sql);
if (applied.status >= 200 && applied.status < 300) {
  console.log('MIGRATION APPLIED OK (status ' + applied.status + ')');
} else {
  console.log('MIGRATION FAILED (status ' + applied.status + '):');
  console.log('  ' + applied.text.slice(0, 400));
  process.exit(1);
}

const check = await q("select count(*)::int n from information_schema.tables where table_schema='public' and table_name='email_sends'");
console.log('email_sends table present:', check.text.includes('"n":1') ? 'YES ✓' : 'NO — ' + check.text.slice(0, 200));
console.log('\nNext:  node scripts/seed-email-sends.mjs --run');
