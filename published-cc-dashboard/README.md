# note daily summary dashboard

Netlify site: https://note-daily-summary-dashboard.netlify.app/

This static dashboard is rebuilt by Netlify. During each build, `scripts/build.mjs` reads every `daily_summary_YYYY-MM-DD.md` file from Google Drive folder `1whu9GZvS7Jk86spJjD_xfy0rndRbJNZ5`, writes `dist/manifest.json`, and publishes `dist/index.html`.

## Build

```bash
npm run build
```

## Netlify environment variables

Set these in the existing Netlify site `note-daily-summary-dashboard`.

- `GOOGLE_DRIVE_FOLDER_ID`: `1whu9GZvS7Jk86spJjD_xfy0rndRbJNZ5`
- `GOOGLE_SERVICE_ACCOUNT_JSON`: the full service account JSON with Drive read access to the folder

Alternative for public Drive files only:

- `GOOGLE_API_KEY`: Google API key

Do not commit credentials to GitHub.

## Cowork operation flow

1. Cowork places a new `daily_summary_YYYY-MM-DD.md` file in the Google Drive folder `note-daily-summaries`.
2. Cowork sends a `POST` request to the Netlify Build Hook URL.
3. Netlify automatically rebuilds this repository, fetches the Drive summaries, regenerates `manifest.json`, and publishes the updated dashboard.
