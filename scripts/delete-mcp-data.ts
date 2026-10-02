/**
 * Account deletion, connected apps: deletes one member's MCP authorization
 * codes, tokens, and grants (`MCP_ACCOUNT_DATA` in
 * `server/mcp/oauth/store.ts`). Codes and tokens are top-level, outside
 * `users/{sub}`, so deleting the user tree alone leaves them behind. Part of
 * the manual deletion procedure in README.md; run it after access is denied
 * (step 2), so a refresh cannot mint a new token. Dry run unless `--apply`:
 *
 *   node --env-file=.env.local scripts/delete-mcp-data.ts <sub> [--apply]
 *
 * Uses GOOGLE_CLOUD_PROJECT and ADC like dev:api, so it targets the real
 * database unless FIRESTORE_EMULATOR_HOST is set. Prints counts only, never
 * document ids (they are token hashes) or contents.
 */
import { deleteDocs, listMcpAccountData } from '../server/mcp/oauth/store.ts';

const apply = process.argv.includes('--apply');
const sub = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (sub === undefined || sub.trim() === '' || sub.includes('/')) {
  console.error('Usage: node --env-file=.env.local scripts/delete-mcp-data.ts <sub> [--apply]');
  process.exit(2);
}

const found = await listMcpAccountData(sub);
for (const { collection, refs } of found) {
  console.log(`${collection}: ${refs.length}`);
}
const total = found.reduce((sum, { refs }) => sum + refs.length, 0);

if (!apply) {
  console.log(`${total} documents. Dry run; pass --apply to delete.`);
} else {
  await deleteDocs(found.flatMap(({ refs }) => refs));
  // Read back, so a partial delete is never reported as done.
  const left = (await listMcpAccountData(sub)).reduce((sum, { refs }) => sum + refs.length, 0);
  if (left > 0) {
    console.error(`${total} deleted, but ${left} remain. Run again.`);
    process.exit(1);
  }
  console.log(`${total} deleted; none remain.`);
}
