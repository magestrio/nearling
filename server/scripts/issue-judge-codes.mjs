// Owner-only, one-time issuance. Run from the repo root with a private SQL output path outside git:
// node server/scripts/issue-judge-codes.mjs /private/tmp/judge-codes.sql
// The SQL contains hashes only. The ten plaintext codes appear once on the operator's terminal.
// Apply the SQL privately with: cd server && npx wrangler d1 execute nearling-db-dev --env dev --remote --file /private/tmp/judge-codes.sql
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

const path = process.argv[2];
if (!path) throw new Error('give a private SQL output path');
if (!process.stdout.isTTY) throw new Error('run only in a private interactive terminal');
const output = resolve(path);
const repo = resolve(import.meta.dirname, '../..');
const withinRepo = relative(repo, output);
if (withinRepo === '' || (!withinRepo.startsWith('..') && !isAbsolute(withinRepo))) {
  throw new Error('the SQL output must be outside the repository');
}
const policy = JSON.parse(readFileSync(new URL('../src/showcasePolicy.json', import.meta.url), 'utf8'));
if (Date.now() >= Date.parse(policy.judgeExpiresAt)) throw new Error('judge issuance has expired');

const codes = Array.from({ length: policy.judgeCodes }, () => randomBytes(16).toString('hex'));
const issuedAt = Date.now();
const expiresAt = Date.parse(policy.judgeExpiresAt);
const values = codes.map((code) => `('${createHash('sha256').update(code).digest('hex')}', ${issuedAt}, ${expiresAt})`);
writeFileSync(output, `INSERT INTO judge_admission_policy (id, code_limit, uses_per_code, admitted_limit, counted_limit)
VALUES (1, ${policy.judgeCodes}, ${policy.redemptionsPerCode}, ${policy.judgeAdmission}, ${policy.countedSignIns})
ON CONFLICT (id) DO UPDATE SET code_limit = excluded.code_limit, uses_per_code = excluded.uses_per_code,
admitted_limit = excluded.admitted_limit, counted_limit = excluded.counted_limit;
INSERT INTO judge_codes (hash, issued_at, expires_at) VALUES\n${values.join(',\n')};\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${codes.join('\n')}\n`);
