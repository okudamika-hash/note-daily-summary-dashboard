import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createSign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "1whu9GZvS7Jk86spJjD_xfy0rndRbJNZ5";

if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 && !process.env.GOOGLE_API_KEY) {
  throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON_B64 or GOOGLE_SERVICE_ACCOUNT_JSON for private Drive access, or GOOGLE_API_KEY for public Drive files.");
}

await mkdir(dist, { recursive: true });

const accessToken = await getAccessToken();
const files = await listDailySummaries({ accessToken });
const summaries = await Promise.all(files.map((file) => fetchSummary({ accessToken, file })));

summaries.sort((a, b) => b.date.localeCompare(a.date));

const manifest = {
  generatedAt: new Date().toISOString(),
  sourceFolderId: folderId,
  latestDate: summaries[0]?.date || null,
  summaries
};

await copyFile(join(root, "index.html"), join(dist, "index.html"));
await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Built ${summaries.length} summaries into dist/manifest.json`);

async function listDailySummaries({ accessToken }) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false and name contains 'daily_summary_'`,
    fields: "files(id,name,mimeType,modifiedTime)",
    orderBy: "name desc",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true"
  });
  const data = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`, { accessToken });
  return (data.files || []).filter((file) => /^daily_summary_\d{4}-\d{2}-\d{2}\.md$/.test(file.name));
}

async function fetchSummary({ accessToken, file }) {
  const url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
  const response = await fetch(withApiKey(url), {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${file.name}: ${response.status} ${await response.text()}`);
  }
  const markdown = await response.text();
  return {
    date: file.name.match(/daily_summary_(\d{4}-\d{2}-\d{2})\.md/)?.[1],
    fileName: file.name,
    fileId: file.id,
    modifiedTime: file.modifiedTime,
    markdown
  };
}

async function driveFetch(url, { accessToken }) {
  const response = await fetch(withApiKey(url), {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  });
  if (!response.ok) {
    throw new Error(`Google Drive API failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function withApiKey(url) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("key", apiKey);
  return parsed.toString();
}

async function getAccessToken() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64
    ? Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8")
    : process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) return null;

  const credentials = JSON.parse(rawJson);
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(signature)}`
    })
  });

  if (!tokenResponse.ok) {
    throw new Error(`Google OAuth token request failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }

  const token = await tokenResponse.json();
  return token.access_token;
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
