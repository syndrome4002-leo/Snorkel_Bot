/*
 * sheet.js — recording a submitted task in the tracking spreadsheet.
 *
 * The row format is taken from the sheet itself:
 *
 *   Task ID, Submission ID, Task Name, Start date, Task Status,
 *   Task Owner, Payment Status, Paid Date, Column 1
 *
 * An existing Sentinel row looks like this, and is what a new one copies:
 *
 *   edfc340f-…, edfc340f-…, "[Sentinel] - cc05c3b0-…", , AI Review, Dmon, , , Sentinel_Ultra
 *
 * Note "AI Review", capitalised as the sheet has it — the column is read by
 * people and by filters, and a lone "AI review" would sort as its own category.
 *
 * WRITING NEEDS A WEBHOOK. The /pub?output=csv link is a published export and is
 * read-only: there is no way to append through it, whatever credentials you
 * have. Writing means either the Sheets API with a service account and the real
 * spreadsheet id, or a small Apps Script bound to the sheet and deployed as a
 * web app. The second is what this expects — see SHEET_SETUP.md — because it
 * needs no Google credentials on this side at all.
 *
 * The CSV link is still used, to read what is already there so the same task is
 * not added twice.
 */

const COLUMNS = [
  'Task ID',
  'Submission ID',
  'Task Name',
  'Start date',
  'Task Status',
  'Task Owner',
  'Payment Status',
  'Paid Date',
  'Column 1',
];

/** What the sheet calls this project, spelled as the existing rows spell it. */
const PROJECT = 'Sentinel_Ultra';
const STATUS_ON_SUBMIT = 'AI Review';

export function rowFor(task, owner) {
  const uid = String(task.UID || task.id || '');
  return {
    'Task ID': uid,
    // The sheet's Sentinel rows repeat the UID here rather than carrying a
    // separate id, so a new row matches what is already there.
    'Submission ID': uid,
    'Task Name': `[Sentinel] - ${uid}`,
    'Start date': '',
    'Task Status': STATUS_ON_SUBMIT,
    'Task Owner': owner || '',
    'Payment Status': '',
    'Paid Date': '',
    'Column 1': PROJECT,
  };
}

/** Splits one CSV line, honouring quotes and doubled quotes inside them. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

/**
 * The task ids already in the sheet.
 *
 * Read before writing so a task submitted twice — a retry, a second machine —
 * does not appear twice. A duplicate row is quiet and easy to miss, and cleaning
 * one up by hand is worse than the request that failed.
 */
export async function existingTaskIds(csvUrl, { fresh = false } = {}) {
  // Google serves the export from a cache. Reading back a row written seconds
  // ago needs a URL it has not seen before.
  const url = fresh ? `${csvUrl}${csvUrl.includes('?') ? '&' : '?'}_=${Date.now()}` : csvUrl;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not read the sheet (HTTP ${res.status}).`);

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return new Set();

  const header = splitCsvLine(lines[0]);
  const idIndex = header.indexOf('Task ID');
  if (idIndex === -1) {
    throw new Error(`The sheet has no "Task ID" column. Columns: ${header.join(', ')}`);
  }

  return new Set(
    lines
      .slice(1)
      .map((line) => (splitCsvLine(line)[idIndex] || '').trim())
      .filter(Boolean)
  );
}

/**
 * Appends one row through the Apps Script webhook.
 *
 * The row is sent as an object keyed by column name, and as an array in column
 * order. The script can use whichever it prefers, and a column inserted in the
 * sheet later does not silently shift every value one place along.
 */
export async function appendRow(webhookUrl, row) {
  /*
   * `redirect: 'manual'`, because the reply is not worth following.
   *
   * Apps Script answers a POST with a 302 to a one-shot script.googleusercontent
   * echo URL. For an anonymous caller that URL then returns a Google 404 — while
   * the script itself has already run and appended the row. Following the
   * redirect and judging by what comes back therefore reports failure on a write
   * that worked, which is the worst way to be wrong: somebody reads the warning,
   * adds the row by hand, and now the sheet has it twice.
   *
   * The 302 is the signal. It means Google accepted the request and ran the
   * script. Whether the row really landed is settled by reading the sheet back,
   * which is what recordSubmission does.
   */
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      row,
      values: COLUMNS.map((c) => row[c] ?? ''),
      columns: COLUMNS,
    }),
    redirect: 'manual',
  });

  // 302 is the normal path; a 200 means the script answered directly.
  if (res.status === 302 || res.status === 303 || res.ok) {
    return { posted: true, status: res.status };
  }

  const body = await res.text().catch(() => '');
  throw new Error(
    `The sheet webhook refused the row (HTTP ${res.status}). ` +
      `Check the deployment is a Web app with access set to Anyone. ${body.slice(0, 200)}`
  );
}

/**
 * Records a submitted task, unless it is already there.
 *
 * Never throws at the caller. Submitting is the real work; failing to write a
 * tracking row should be reported and left for a person, not allowed to turn a
 * successful submission into an error.
 */
export async function recordSubmission(task, { csvUrl, webhookUrl, owner }) {
  if (!webhookUrl) {
    return { skipped: true, reason: 'no sheet webhook configured' };
  }

  const uid = String(task.UID || task.id || '');
  const row = rowFor(task, owner);

  try {
    if (csvUrl) {
      const already = await existingTaskIds(csvUrl);
      if (already.has(uid)) return { skipped: true, reason: 'already in the sheet' };
    }

    const posted = await appendRow(webhookUrl, row);

    /*
     * Read the sheet back rather than trusting the reply.
     *
     * The webhook cannot tell us whether the row landed — its response is a
     * redirect we are not allowed to follow — so the only honest confirmation is
     * the row appearing in the sheet. A script that is deployed but bound to no
     * spreadsheet, or throwing inside doPost, answers exactly like one that
     * worked; this is what tells them apart.
     *
     * Unverified is not failed. The write may simply not have propagated to the
     * export yet, and claiming failure would invite a duplicate.
     */
    if (!csvUrl) return { ...posted, appended: true, verified: null, row };

    await new Promise((r) => setTimeout(r, 1500));
    const after = await existingTaskIds(csvUrl, { fresh: true }).catch(() => null);
    const verified = after ? after.has(uid) : null;

    return { ...posted, appended: true, verified, row };
  } catch (err) {
    return { skipped: true, failed: true, reason: err.message, row };
  }
}
