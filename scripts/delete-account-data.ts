/**
 * Account deletion request, Firestore part: removes everything Sous stores
 * for one member, collection by collection (`ACCOUNT_DELETION_STEPS` in
 * `server/accountDeletion.ts`), in order, reading each back. Step 4 of the
 * manual deletion procedure in README.md; photos in GCS are step 5.
 *
 *   node --env-file=.env.local scripts/delete-account-data.ts <sub> [--apply]
 *
 * Dry run unless `--apply`: prints what each step would change. `--apply`
 * refuses while the member still has access (active in `members/{sub}`, or an
 * address in `ALLOWED_EMAILS`), because a signed-in client could push its
 * library back; deny access first (README steps 1–2). Prints counts only,
 * never document ids, emails, or contents.
 *
 * Uses GOOGLE_CLOUD_PROJECT and ADC like dev:api, so it targets the real
 * database unless FIRESTORE_EMULATOR_HOST is set.
 */
import {
  ACCOUNT_DELETION_ORDER,
  ACCOUNT_DELETION_STEPS,
  deletionRefusal,
  readDeletionSubject,
} from '../server/accountDeletion.ts';
import { allowedEmails } from '../server/env.ts';
import { isSafeFirestoreDocumentId } from '../server/grants.ts';

const REFUSAL_TEXT = {
  'bad-sub': 'That is not a Firestore document id.',
  'no-allowlist': 'ALLOWED_EMAILS is not set, so an owner cannot be ruled out. Run with --env-file=.env.local.',
  'still-member': 'members/{sub} is still active. Revoke access first (README steps 1–2).',
  owner: "The profile's email is in ALLOWED_EMAILS. Remove it from the deployed allowlist first.",
} as const;

const apply = process.argv.includes('--apply');
const sub = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (sub === undefined || sub.trim() === '') {
  console.error('Usage: node --env-file=.env.local scripts/delete-account-data.ts <sub> [--apply]');
  process.exit(2);
}
// Before any read: a path-like value would address some other document.
if (!isSafeFirestoreDocumentId(sub)) {
  console.error(REFUSAL_TEXT['bad-sub']);
  process.exit(2);
}

const subject = await readDeletionSubject(sub);
const refusal = deletionRefusal({ sub, ...subject, allowedRaw: allowedEmails() });

let total = 0;
for (const name of ACCOUNT_DELETION_ORDER) {
  for (const line of await ACCOUNT_DELETION_STEPS[name].inventory(sub)) {
    console.log(`${line.label}: ${line.count}`);
    total += line.count;
  }
}

if (!apply) {
  if (refusal !== null) console.log(`Note: --apply would refuse. ${REFUSAL_TEXT[refusal]}`);
  console.log(`${total} to change. Dry run; pass --apply to delete.`);
  process.exit(0);
}

if (refusal !== null) {
  console.error(`Refusing to apply. ${REFUSAL_TEXT[refusal]}`);
  process.exit(1);
}

const now = Date.now();
for (const name of ACCOUNT_DELETION_ORDER) {
  // Each step reads its own data back and throws if any remains.
  await ACCOUNT_DELETION_STEPS[name].apply(sub, now);
  console.log(`${name}: done`);
}

let left = 0;
for (const name of ACCOUNT_DELETION_ORDER) {
  for (const line of await ACCOUNT_DELETION_STEPS[name].inventory(sub)) left += line.count;
}
if (left > 0) {
  console.error(`${left} still found after apply. Run the dry run to see where.`);
  process.exit(1);
}
console.log('Firestore data deleted; none remains. Now delete the photos (README step 5).');
