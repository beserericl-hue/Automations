// Email the E2E result through the Workbench's own Postal server.
//
//   node notify.mjs <commit> <note> <status 0|1> [log ...]
//
// The summary is read from the Playwright logs: each pass's counts and the name of every test that
// failed or was flaky. Without POSTAL_API_URL / POSTAL_API_KEY / E2E_NOTIFY_EMAIL it prints the
// summary and sends nothing, so a missing mail setting never hides the result from the deploy log.

import fs from 'fs';

const [commit = '', note = '', status = '1', ...logs] = process.argv.slice(2);
const failed = status !== '0';

const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const lines = logs.flatMap((f) => (fs.existsSync(f) ? strip(fs.readFileSync(f, 'utf8')).split('\n') : []));
const counts = lines.filter((l) => /^\s+\d+ (passed|failed|flaky|skipped|did not run)\b/.test(l) || /^=== Pass /.test(l));
// Playwright's end-of-run summary lists each failed / flaky test on an indented "[project] › ..."
// line under its "N failed" / "N flaky" heading. (Progress lines start "[n/m]", not indented.)
const named = [];
let heading = '';
for (const l of lines) {
  const h = /^\s+\d+ (failed|flaky)\b/.exec(l);
  if (h) { heading = h[1]; continue; }
  if (/^\s+\d+ (passed|skipped|did not run)\b/.test(l) || /^=== /.test(l)) { heading = ''; continue; }
  if (heading && /^\s+\[[\w-]+\] › /.test(l)) named.push(`${heading}: ${l.trim()}`);
}

const summary = [
  `Writers Workbench E2E on DEV — ${failed ? 'FAILED' : 'passed'} — commit ${commit || 'unknown'}`,
  '',
  note,
  ...counts.map((l) => l.trim()),
  '',
  ...(named.length ? ['Failed or flaky:', ...named] : []),
  '',
  'Full output: Railway → writer-e2e → the latest deployment\'s logs.',
]
  .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
  .join('\n');

console.log(summary);

const { POSTAL_API_URL, POSTAL_API_KEY, E2E_NOTIFY_EMAIL, SENDER_EMAIL } = process.env;
if (!POSTAL_API_URL || !POSTAL_API_KEY || !E2E_NOTIFY_EMAIL) {
  console.log('(no email sent: POSTAL_API_URL, POSTAL_API_KEY and E2E_NOTIFY_EMAIL are not all set)');
  process.exit(0);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const res = await fetch(`${POSTAL_API_URL.replace(/\/+$/, '')}/send/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Server-API-Key': POSTAL_API_KEY },
  body: JSON.stringify({
    to: [E2E_NOTIFY_EMAIL],
    from: SENDER_EMAIL || 'eve@courseworx.media',
    subject: `${failed ? 'FAILED' : 'Passed'}: Writers Workbench E2E on DEV (${commit || 'unknown'})`,
    plain_body: summary,
    html_body: `<pre style="font:13px/1.5 ui-monospace,monospace">${esc(summary)}</pre>`,
  }),
}).catch((err) => ({ ok: false, status: String(err) }));
console.log(res.ok ? `(result emailed to ${E2E_NOTIFY_EMAIL})` : `(email failed: ${res.status})`);
