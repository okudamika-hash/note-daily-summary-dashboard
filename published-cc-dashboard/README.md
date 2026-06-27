# note daily summary dashboard

Netlify site: https://note-daily-summary-dashboard.netlify.app/

This static dashboard is rebuilt by Netlify. During each build, `scripts/build.mjs` reads every `daily_summary_YYYY-MM-DD.md` file from Google Drive folder `1whu9GZvS7Jk86spJjD_xfy0rndRbJNZ5`, reads the note post analytics Google Sheet, writes `dist/manifest.json`, and publishes `dist/index.html`.

## Build

```bash
npm run build
```

## Netlify environment variables

Set these in the existing Netlify site `note-daily-summary-dashboard`.

- `GOOGLE_DRIVE_FOLDER_ID`: `1whu9GZvS7Jk86spJjD_xfy0rndRbJNZ5`
- `GOOGLE_SERVICE_ACCOUNT_JSON`: the full service account JSON with Drive read access to the folder
- `POST_ANALYTICS_SPREADSHEET_ID`: optional override for the note analytics sheet. Defaults to `1A7TI7X3wz64K049o7KBOi7G8JYyV3kgDFvPu885HyJM`
- `POST_ANALYTICS_SHEET_GID`: optional override for the post log tab. Defaults to `1702614120`

The Google service account must have viewer access to both the Drive summary folder and the note analytics spreadsheet.

Alternative for public Drive files only:

- `GOOGLE_API_KEY`: Google API key

Do not commit credentials to GitHub.

## Cowork operation flow

1. Cowork places a new `daily_summary_YYYY-MM-DD.md` file in the Google Drive folder `note-daily-summaries`.
2. Cowork sends a `POST` request to the Netlify Build Hook URL.
3. Netlify automatically rebuilds this repository, fetches the Drive summaries and the analytics spreadsheet, regenerates `manifest.json`, and publishes the updated dashboard.

The scheduled GitHub Action triggers the Netlify build hook at `30 19 * * *` UTC, which is 04:30 every morning in Japan Standard Time.
