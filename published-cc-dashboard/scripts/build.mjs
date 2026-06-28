import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createSign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "1whu9GZvS7Jk86spJjD_xfy0rndRbJNZ5";
const analyticsSpreadsheetId = process.env.POST_ANALYTICS_SPREADSHEET_ID || "1A7TI7X3wz64K049o7KBOi7G8JYyV3kgDFvPu885HyJM";
const analyticsSheetGid = Number(process.env.POST_ANALYTICS_SHEET_GID || "1702614120");

if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 && !process.env.GOOGLE_API_KEY) {
  throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON_B64 or GOOGLE_SERVICE_ACCOUNT_JSON for private Drive access, or GOOGLE_API_KEY for public Drive files.");
}

await mkdir(dist, { recursive: true });

const accessToken = await getAccessToken();
const files = await listDailySummaries({ accessToken });
const [summaries, postAnalytics] = await Promise.all([
  Promise.all(files.map((file) => fetchSummary({ accessToken, file }))),
  fetchPostAnalytics({ accessToken })
]);

summaries.sort((a, b) => b.date.localeCompare(a.date));

const manifest = {
  generatedAt: new Date().toISOString(),
  sourceFolderId: folderId,
  postAnalytics,
  latestDate: summaries[0]?.date || null,
  summaries
};

await copyFile(join(root, "index.html"), join(dist, "index.html"));
await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Built ${summaries.length} summaries into dist/manifest.json`);

async function listDailySummaries({ accessToken }) {
  let files = await queryDriveFiles({
    accessToken,
    q: `'${folderId}' in parents and trashed = false and name contains 'daily_summary_'`
  });

  if (files.length === 0) {
    files = await queryDriveFiles({
      accessToken,
      q: "trashed = false and name contains 'daily_summary_'"
    });
  }

  return files.filter((file) => /^daily_summary_\d{4}-\d{2}-\d{2}\.md$/.test(file.name));
}

async function queryDriveFiles({ accessToken, q }) {
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,modifiedTime)",
    orderBy: "name desc",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true"
  });
  const data = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`, { accessToken });
  return data.files || [];
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

async function fetchPostAnalytics({ accessToken }) {
  const metadataParams = new URLSearchParams({
    fields: "sheets(properties(sheetId,title))"
  });
  const metadata = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${analyticsSpreadsheetId}?${metadataParams}`,
    { accessToken }
  );
  const sheet = metadata.sheets
    ?.map((entry) => entry.properties)
    .find((properties) => properties.sheetId === analyticsSheetGid);

  if (!sheet?.title) {
    throw new Error(`Analytics sheet gid ${analyticsSheetGid} was not found in spreadsheet ${analyticsSpreadsheetId}`);
  }

  const valuesParams = new URLSearchParams({
    majorDimension: "ROWS",
    valueRenderOption: "FORMATTED_VALUE"
  });
  const range = encodeURIComponent(quoteSheetName(sheet.title));
  const valuesData = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${analyticsSpreadsheetId}/values/${range}?${valuesParams}`,
    { accessToken }
  );

  return buildPostAnalytics({
    spreadsheetId: analyticsSpreadsheetId,
    sheetGid: analyticsSheetGid,
    sheetTitle: sheet.title,
    rows: valuesData.values || []
  });
}

async function sheetsFetch(url, { accessToken }) {
  const response = await fetch(withApiKey(url), {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  });
  if (!response.ok) {
    throw new Error(`Google Sheets API failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function buildPostAnalytics({ spreadsheetId, sheetGid, sheetTitle, rows }) {
  const headerIndex = rows.findIndex((row) => {
    const normalized = row.map(normalizeHeader);
    return normalized.includes("pv") && normalized.includes("スキ") && normalized.includes("タイプ");
  });

  if (headerIndex === -1) {
    throw new Error(`Analytics source sheet ${sheetTitle} does not contain a post log header row`);
  }

  const headers = rows[headerIndex].map(normalizeHeader);
  const indexes = {
    date: findHeader(headers, ["公開日", "日付"]),
    day: findHeader(headers, ["曜日"]),
    title: findHeader(headers, ["タイトル"]),
    type: findHeader(headers, ["タイプ"]),
    decoration: findHeader(headers, ["タイトル装飾", "装飾"]),
    pv: findHeader(headers, ["pv", "PV"]),
    likes: findHeader(headers, ["スキ", "いいね"]),
    likeRate: findHeader(headers, ["スキ率", "いいね率"]),
    comments: findHeader(headers, ["コメント", "コメント数"])
  };

  for (const [key, index] of Object.entries(indexes)) {
    if (index === -1 && ["day", "type", "decoration", "pv", "likes"].includes(key)) {
      throw new Error(`Analytics source sheet ${sheetTitle} is missing required column: ${key}`);
    }
  }

  const records = rows.slice(headerIndex + 1)
    .map((row) => toPostRecord(row, indexes))
    .filter((record) => record && Number.isFinite(record.pv) && Number.isFinite(record.likes));

  const totalPv = records.reduce((sum, record) => sum + record.pv, 0);
  const totalLikes = records.reduce((sum, record) => sum + record.likes, 0);
  const overallLikeRate = totalPv > 0 ? totalLikes / totalPv : 0;
  const overTenPercentCount = records.filter((record) => record.likeRate > 0.1).length;

  return {
    source: {
      spreadsheetId,
      sheetGid,
      sheetTitle,
      snapshotLabel: "最新値",
      fetchedAt: new Date().toISOString()
    },
    kpis: {
      totalPv,
      totalLikes,
      overallLikeRate,
      publishedCount: records.length,
      overTenPercentCount
    },
    tables: {
      byType: groupRecords(records, "type"),
      byDecoration: groupRecords(records, "decoration"),
      byDay: groupRecords(records, "day", ["月", "火", "水", "木", "金", "土", "日"]),
      byTitleDaily: buildTitleDailyRows(records)
    }
  };
}

function toPostRecord(row, indexes) {
  const pv = parseNumber(row[indexes.pv]);
  const likes = parseNumber(row[indexes.likes]);
  if (!Number.isFinite(pv) || !Number.isFinite(likes)) return null;

  const explicitRate = indexes.likeRate === -1 ? NaN : parsePercent(row[indexes.likeRate]);
  return {
    date: valueAt(row, indexes.date),
    day: valueAt(row, indexes.day) || "不明",
    title: valueAt(row, indexes.title),
    type: valueAt(row, indexes.type) || "不明",
    decoration: valueAt(row, indexes.decoration) || "不明",
    pv,
    likes,
    likeRate: Number.isFinite(explicitRate) ? explicitRate : (pv > 0 ? likes / pv : 0),
    comments: indexes.comments === -1 ? 0 : parseNumber(row[indexes.comments]) || 0
  };
}

function buildTitleDailyRows(records) {
  const groups = new Map();
  for (const record of records) {
    const title = record.title || "無題";
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(record);
  }

  return [...groups.entries()]
    .map(([title, group]) => {
      const sorted = [...group].sort(compareRecordsByDateDesc);
      const latest = sorted[0];
      const previous = sorted[1] || null;
      return {
        date: latest.date,
        title,
        pv: latest.pv,
        pvDelta: previous ? latest.pv - previous.pv : null,
        likes: latest.likes,
        likesDelta: previous ? latest.likes - previous.likes : null,
        likeRate: latest.likeRate,
        likeRateDelta: previous ? latest.likeRate - previous.likeRate : null,
        comments: latest.comments,
        commentsDelta: previous ? latest.comments - previous.comments : null,
        previousDate: previous?.date || null
      };
    })
    .sort((a, b) => b.likeRate - a.likeRate || b.pv - a.pv || a.title.localeCompare(b.title, "ja"));
}

function compareRecordsByDateDesc(a, b) {
  return dateSortValue(b.date) - dateSortValue(a.date);
}

function dateSortValue(value) {
  const normalized = String(value || "").trim().replace(/[./]/g, "-");
  const match = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return 0;
  return Number(`${match[1]}${match[2].padStart(2, "0")}${match[3].padStart(2, "0")}`);
}

function groupRecords(records, key, order = null) {
  const groups = new Map();
  for (const record of records) {
    const label = record[key] || "不明";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(record);
  }

  const entries = [...groups.entries()].map(([label, group]) => ({
    label,
    count: group.length,
    averageLikeRate: average(group.map((record) => record.likeRate)),
    averagePv: average(group.map((record) => record.pv)),
    averageLikes: average(group.map((record) => record.likes))
  }));

  if (order) {
    return entries.sort((a, b) => {
      const aIndex = order.indexOf(a.label);
      const bIndex = order.indexOf(b.label);
      if (aIndex === -1 && bIndex === -1) return a.label.localeCompare(b.label, "ja");
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });
  }

  return entries;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length === 0) return 0;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function findHeader(headers, aliases) {
  return headers.findIndex((header) => aliases.some((alias) => normalizeHeader(alias) === header));
}

function normalizeHeader(value) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

function valueAt(row, index) {
  if (index === -1) return "";
  return String(row[index] || "").trim();
}

function parseNumber(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  if (!normalized) return NaN;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : NaN;
}

function parsePercent(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  if (!normalized) return NaN;
  if (normalized.endsWith("%")) {
    const number = Number(normalized.slice(0, -1));
    return Number.isFinite(number) ? number / 100 : NaN;
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)) return NaN;
  return number > 1 ? number / 100 : number;
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
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
  const header = { alg: "RS256", typ: "JWT", kid: credentials.private_key_id };
  const claim = {
    iss: credentials.client_email,
    scope: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly"
    ].join(" "),
    aud: credentials.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);

  const tokenResponse = await fetch(credentials.token_uri || "https://oauth2.googleapis.com/token", {
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
