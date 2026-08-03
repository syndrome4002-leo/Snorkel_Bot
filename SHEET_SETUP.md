# Writing submitted tasks into the tracking sheet

Every task the bot submits gets a row:

| Task ID | Submission ID | Task Name | Start date | Task Status | Task Owner | Payment Status | Paid Date | Column 1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<uid>` | `<uid>` | `[Sentinel] - <uid>` | | `AI Review` | your Owner ID | | | `Sentinel_Ultra` |

Copied from the Sentinel rows already in the sheet, including `AI Review`
capitalised the way they capitalise it — that column gets filtered on, and a lone
`AI review` would sort as a category of its own.

## Why a published CSV link is not enough

The link in **Sheet URL**:

```
https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?output=csv
```

is a *published export*. It is read-only by design — there is no request you can
make to it that adds a row, with or without credentials. It is still worth
setting, because the bot reads it to check whether a task is already listed
before adding it again.

Writing needs one of two things: the Google Sheets API with a service account
and the sheet shared with it, or a small script bound to the sheet. The script is
below, because it needs no Google credentials on the bot's side at all.

## Setting up the webhook

1. Open the spreadsheet, then **Extensions > Apps Script**.
2. Delete whatever is in `Code.gs` and paste this:

```javascript
/**
 * Appends one row to the first sheet.
 *
 * The bot sends both an object keyed by column name and an array in column
 * order. The object is used, so inserting a column in the sheet later does not
 * silently shift every value one place along.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  // Two submissions landing together would otherwise both read the same last
  // row and one would overwrite the other.
  lock.waitLock(30000);

  try {
    var body = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    var row = headers.map(function (name) {
      return body.row && body.row[name] != null ? body.row[name] : '';
    });

    sheet.appendRow(row);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, row: row }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
```

3. **Deploy > New deployment**, type **Web app**.
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
4. Approve the permissions it asks for.
5. Copy the URL it gives you. It looks like:

```
https://script.google.com/macros/s/AKfy.../exec
```

## On the dashboard

**Settings > Tracking sheet**:

| | |
| --- | --- |
| Owner ID | `Syndrome` |
| Sheet URL (published CSV) | the `/pub?output=csv` link |
| Append webhook URL | the `/exec` link from step 5 |

Leave the webhook empty and nothing is written — the rest of the system carries
on exactly as before.

## A note on "Anyone" access

The web app has to be reachable without a Google login, because the bot has no
Google identity. Anyone who has the URL can append a row to this sheet, so treat
it as a secret: it is not in the repository, only in the dashboard settings.

If that is not acceptable, the alternative is the Sheets API with a service
account — more setup, and the credentials then have to reach every machine that
submits.

## When it goes wrong

Writing the row can never fail a submission. The task really has been submitted
by that point, and a missing tracking row is a note to write rather than work to
redo. A failure is logged and recorded on the task:

```
⚠️ sheet_row: <uid>: could not add the sheet row — The sheet webhook refused the row (HTTP 401)
```

A task already in the sheet is skipped rather than duplicated. A duplicate row is
quiet, easy to miss, and worse to clean up than a request that simply failed.
