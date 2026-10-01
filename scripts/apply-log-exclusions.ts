/**
 * Adds the link-token exclusion (`scripts/logExclusions.ts`) to the `_Default`
 * log sink of the production project, keeping every other exclusion and the
 * sink's destination and filter. Dry run unless `--apply`:
 *
 *   node scripts/apply-log-exclusions.ts [--apply]
 *
 * Uses ADC (`gcloud auth application-default login`); the account needs
 * permission to update sinks (`roles/logging.configWriter` or owner). This
 * changes production logging; run `--apply` only with the owner's approval,
 * and before deploying the `/privacy` text that relies on it.
 */
import { GoogleAuth } from 'google-auth-library';
import {
  LINK_TOKEN_EXCLUSION,
  exclusionsApplied,
  planExclusions,
  type LogExclusion,
} from './logExclusions.ts';

const PROJECT = 'cooking-assistant-508423';
const SINK_URL = `https://logging.googleapis.com/v2/projects/${PROJECT}/sinks/_Default`;

interface Sink {
  name: string;
  destination: string;
  filter?: string;
  disabled?: boolean;
  exclusions?: LogExclusion[];
}

const apply = process.argv.includes('--apply');
const client = await new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  projectId: PROJECT,
}).getClient();

async function readSink(): Promise<Sink> {
  const response = await client.request<Sink>({ url: SINK_URL });
  return response.data;
}

function describe(sink: Sink): string {
  const names = (sink.exclusions ?? []).map(
    (exclusion) => `${exclusion.name}${exclusion.disabled === true ? ' (disabled)' : ''}`,
  );
  return `_Default -> ${sink.destination}; exclusions: ${names.length === 0 ? '(none)' : names.join(', ')}`;
}

const before = await readSink();
console.log(`Before: ${describe(before)}`);

const plan = planExclusions(before.exclusions ?? []);
if (plan.kind === 'in_place') {
  console.log(`${LINK_TOKEN_EXCLUSION.name} is already in place. Nothing to do.`);
  process.exit(0);
}

console.log(`Plan: ${plan.kind} ${LINK_TOKEN_EXCLUSION.name}`);
console.log(`  filter: ${LINK_TOKEN_EXCLUSION.filter}`);
if (!apply) {
  console.log('Dry run; pass --apply to write.');
  process.exit(0);
}

await client.request({
  url: `${SINK_URL}?updateMask=exclusions`,
  method: 'PATCH',
  data: { exclusions: plan.next },
});

const after = await readSink();
console.log(`After:  ${describe(after)}`);
const sinkUnchanged =
  after.destination === before.destination &&
  (after.filter ?? '') === (before.filter ?? '') &&
  (after.disabled === true) === (before.disabled === true);
if (!sinkUnchanged || !exclusionsApplied(before.exclusions ?? [], after.exclusions ?? [])) {
  console.error('The sink does not have the expected shape after the update. Check it by hand.');
  process.exit(1);
}
console.log('Verified: the exclusion is present and enabled, and the sink is otherwise unchanged.');
