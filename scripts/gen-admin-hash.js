#!/usr/bin/env node
/**
 * Generate the bcrypt hash for the admin panel.
 *
 * The `#admin` PAX-edit panel authenticates against `ADMIN_PASSCODE_HASH`
 * (a bcrypt hash), NOT a plaintext password. This script turns a chosen
 * passcode into the hash you paste into Netlify → Environment variables.
 *
 * Usage:
 *   node scripts/gen-admin-hash.js "your-chosen-passcode"
 *
 * Then in Netlify (Site configuration → Environment variables):
 *   ADMIN_PASSCODE_HASH = <the $2a$... string this prints>
 *
 * The plaintext passcode is what the region types on the site; it is never
 * stored. Only the hash lives in Netlify.
 */
const bcrypt = require('bcryptjs');

const passcode = process.argv[2];
if (!passcode) {
  console.error('Usage: node scripts/gen-admin-hash.js "your-passcode"');
  process.exit(1);
}

const hash = bcrypt.hashSync(passcode, 10);
console.log('\nADMIN_PASSCODE_HASH=' + hash + '\n');
console.log('Paste the value above into Netlify → Environment variables.');
console.log('Verify:', bcrypt.compareSync(passcode, hash) ? 'OK ✅' : 'MISMATCH ❌');
