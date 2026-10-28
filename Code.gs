/**
 * ARRIVE Dashboard API — Heavy Data / Paginated Backend
 *
 * 4 Google Spreadsheets:
 * Q1 → January, February, March
 * Q2 → April, May, June
 * Q3 → July, August, September
 * Q4 → October, November, December
 *
 * Supported:
 *
 * ?action=listSheets
 *
 * ?action=diagnose&sheet=July
 *
 * ?sheet=July&page=1&pageSize=5000
 *
 * If page is omitted, page=1.
 * If pageSize is omitted, pageSize=5000.
 */

// ============================================================
// 1. SPREADSHEET SOURCES
// ============================================================

var SPREADSHEET_IDS = {
  Q1: "1_JaWfM199wOhRw2-7znStlvw9R2hENWg8s-6Dc_zYWU",
  Q2: "1auCRCzBQcO-ej4JeoEyYzhfBiGtlBb9WdM4iCbNNxkA",
  Q3: "1FUCWpI3DvJ6FRiEJ7eR6wNIn6iLIcJ_PSBBgxT74jJo",
  Q4: "1EosPPKKZ549a6cEGcF_7sCuG9W_ZQmbi6s0MQgehdTs"
};


// ============================================================
// 2. MONTH → QUARTER
// ============================================================

var MONTH_SOURCE = {
  January: "Q1",
  February: "Q1",
  March: "Q1",

  April: "Q2",
  May: "Q2",
  June: "Q2",

  July: "Q3",
  August: "Q3",
  September: "Q3",

  October: "Q4",
  November: "Q4",
  December: "Q4"
};


// ============================================================
// 3. MONTH ORDER
// ============================================================

var MONTH_ORDER = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];


// ============================================================
// 4. DEFAULT / SAFETY LIMITS
// ============================================================

var DEFAULT_PAGE_SIZE = 5000;

var MAX_PAGE_SIZE = 5000;

// ============================================================
// 4Z. ALL MONTHS MODE
// ============================================================
// A virtual "sheet" name the frontend requests to get a combined summary
// across every AVAILABLE month's Compact Summary. Never a real sheet tab —
// doGet routes it to getAllMonthsDashboardSummary() and nowhere else (in
// particular, never to getMonthPage()/raw pagination — see doGet below).
var ALL_MONTHS_SENTINEL = "ALL_MONTHS";
// Safety budget for the (rare) filtered All-Months path, which must fall
// back to live per-month aggregation since persisted snapshots are
// unfiltered — stops stacking further 100k-row live computations within one
// request once this much wall-clock time has already been spent, rather
// than risk exceeding Apps Script's execution ceiling. Any month skipped
// this way is reported explicitly (skippedMonths), never silently guessed.
var ALL_MONTHS_TIME_BUDGET_MS = 260000;

// ============================================================
// 4A. PERSISTENT DASHBOARD SUMMARY STORAGE
// ============================================================
// Each Q1/Q2/Q3/Q4 spreadsheet gets one internal tab named
// DASHBOARD_SUMMARY. It stores pre-built COMPACT summaries only.
// The dashboard reads these snapshots instantly instead of rebuilding
// a 100k+ row month during normal management viewing.
var PERSISTENT_SUMMARY_SHEET = "DASHBOARD_SUMMARY";
var PERSISTENT_SUMMARY_VERSION = "2";
var SUMMARY_TAXONOMY_VERSION = 2; // 1 = old buckets; 2 = 8-card taxonomy (return closed/open/hold, rejection from final status)
var PERSISTENT_SUMMARY_CHUNK_SIZE = 45000; // safely below cell-size limits



// ============================================================
// 5. MAIN ENTRY
// ============================================================

function doGet(e) {

  var requestId = Utilities.getUuid();
  var reqStart = new Date().getTime();
  var params =
    (e && e.parameter)
      ? e.parameter
      : {};
  var action = params.action || "(page)";
  var sheetName = params.sheet || "";
  params.__requestId = requestId; // threaded through so downstream functions can log under the same id

  console.log("[REQUEST START] " + JSON.stringify({
    requestId: requestId, action: action, sheet: sheetName,
    debug: params.debug || "", filters: params.filters || "",
    dateFrom: params.dateFrom || "", dateTo: params.dateTo || "",
    refresh: params.refresh || "", ts: new Date().toISOString()
  }));

  try {

    var result;

    // --------------------------------------------------------
    // LIST MONTHS
    // --------------------------------------------------------

    if (action === "listSheets") {
      result = listSheetsPayload();
    }

    // --------------------------------------------------------
    // BUILD / REFRESH PERSISTENT COMPACT SUMMARY
    // Admin / Apps Script execution only. This is the ONLY path
    // that performs the heavy raw-month aggregation for a snapshot.
    // --------------------------------------------------------
    else if (action === "buildSummary") {
      if (!sheetName) result = { success:false, error:"لم يتم تحديد الشهر." };
      else result = buildAndSaveMonthSummary(sheetName);
    }

    else if (action === "buildQuarterSummaries") {
      result = buildQuarterSummaries(params.quarter || "");
    }

    else if (action === "buildMissingSummaries") {
      result = buildMissingMonthSnapshots();
    }

    else if (action === "ageReport") {
      result = getAgeReport(params);
    }

    else if (action === "buildAgeSnapshot") {
      if (!sheetName) result = { success: false, error: "لم يتم تحديد الشهر." };
      else result = buildAgeSnapshot(sheetName);
    }

    // --------------------------------------------------------
    // DIAGNOSTIC
    // --------------------------------------------------------

    else if (action === "diagnose") {
      result = diagnoseMonth(sheetName);
    }

    else if (action === "diagnoseStatuses") {
      result = diagnoseStatusBreakdown(sheetName);
    }

    else if (action === "diagnoseJuneStatuses") {
      result = diagnoseJuneStatuses();
    }

    // --------------------------------------------------------
    // SLA SETTINGS (persisted single source of truth — Batch 1 fix)
    // getSlaSettings: read-only, called by the frontend on every boot.
    // saveSlaSettings: called only from the Settings tab's Apply buttons.
    // --------------------------------------------------------

    else if (action === "getSlaSettings") {
      result = getSlaSettingsPayload();
    }

    else if (action === "saveSlaSettings") {
      result = saveSlaSettingsPayload(params);
    }

    // --------------------------------------------------------
    // DASHBOARD SUMMARY (server-side aggregation — compact JSON,
    // no raw rows). This is what the Dashboard now uses for the normal
    // KPI/overview view instead of downloading the entire raw month.
    // --------------------------------------------------------

    else if (action === "dashboard") {
      if (!sheetName) {
        result = { success: false, error: "لم يتم تحديد الشهر. استخدم ?action=dashboard&sheet=July" };
      } else if (sheetName === ALL_MONTHS_SENTINEL) {
        result = getAllMonthsDashboardSummary(params);
      } else {
        result = getMonthDashboardSummary(sheetName, params);
      }
    }

    // --------------------------------------------------------
    // NORMAL DATA REQUEST (raw pagination — Excel Raw Export only)
    // --------------------------------------------------------

    else if (!sheetName) {
      result = { success: false, error: "لم يتم تحديد الشهر. استخدم ?sheet=July" };
    }

    else if (sheetName === ALL_MONTHS_SENTINEL) {
      // All Months has no single raw sheet to page through by design —
      // Raw Export must be done per real month.
      result = { success: false, error: "لا يمكن تصدير بيانات خام لوضع كل الشهور مجتمعة — اختر شهرًا محددًا لتصدير البيانات الخام." };
    }

    else {
      result = getMonthPage(sheetName, params);
    }

    var reqEnd = new Date().getTime();
    console.log("[REQUEST END] " + JSON.stringify({
      requestId: requestId, action: action, sheet: sheetName,
      durationMs: (reqEnd - reqStart), success: !(result && result.success === false),
      cached: !!(result && result.cached), empty: !!(result && (result.empty || result.noData))
    }));

    return jsonResponse(result);

  }

  catch (err) {

    var reqEndErr = new Date().getTime();
    console.log("[REQUEST ERROR] " + JSON.stringify({
      requestId: requestId, action: action, sheet: sheetName,
      durationMs: (reqEndErr - reqStart),
      error: String(err && err.message ? err.message : err)
    }));

    return jsonResponse({

      success: false,

      error:
        String(
          err && err.message
            ? err.message
            : err
        )

    });

  }

}


// ============================================================
// 5B. DASHBOARD SUMMARY (server-side aggregation)
//
// Reproduces, on the server, the EXACT same business logic the dashboard
// used to run client-side over raw rows (see dashboard.html's
// detectColumnMap / classifyStatus / computeKPIs / groupBy / dedupeForKPI):
//   - column detection via the same alias list
//   - AWB dedup (keep the latest record per AWB by last-status date)
//   - status bucket classification (delivered/returned/rejected/pending/unknown)
//   - KPI formulas: deliveryRate, returnRate, rejectedRate, successRate,
//     SLA achievement (against the DEFAULT 2-day target — per-branch SLA
//     overrides are a client-side Settings feature and still apply once the
//     dashboard's background raw-data load completes, exactly as before)
//   - branch / customer / province / area / status / final-status aggregates,
//     shaped identically to groupBy()'s output so the client's existing
//     rendering functions can consume them with zero changes
//   - a daily trend series (for the Overview trend chart)
//
// Cached via CacheService (5-minute TTL) so repeated requests for the same
// month are near-instant without re-reading the sheet. Pass &refresh=1 to
// bypass the cache and recompute (e.g. right after the sheet was edited).
// ============================================================

var DASHBOARD_CACHE_TTL_SECONDS = 300; // 5 minutes — short enough that edits show up soon, long enough to absorb repeat requests
var LIST_SHEETS_CACHE_TTL_SECONDS = 600; // 10 minutes — month/tab names change far less often than shipment data; this avoids opening all 4 spreadsheets on every boot/list-refresh
var CACHE_CHUNK_SIZE = 90000; // stay safely under CacheService's 100KB-per-key limit

// SNAPSHOT GENERATION STAMP (see docs/production-debug-fixes.md — Bug #6:
// obsolete All Months cache). Every dashboard-result CacheService entry
// (single month AND All Months, in getMonthDashboardSummary /
// getAllMonthsDashboardSummary) folds this stamp into its cache key. It
// only changes when saveMonthSummary_() actually writes a snapshot — so a
// cached result's validity now depends on the ACTUAL current snapshot
// state, not only on the fixed 5-minute TTL. Building/updating ANY month's
// snapshot bumps this once, which makes every previously-cached dashboard
// result (single month or All Months, for any filter/date/SLA
// combination) an automatic cache miss on its very next request — no
// enumeration or explicit deletion of old cache entries needed; they are
// simply never matched again and expire naturally via their own TTL.
// Fails open on either side: if PropertiesService is unavailable for any
// reason, reads fall back to a constant stamp and writes silently no-op,
// which just degrades to the previous TTL-only behavior — never throws.
var SNAPSHOT_GENERATION_PROPERTY_KEY = "SNAPSHOT_GENERATION_STAMP";
function getSnapshotGenerationStamp_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(SNAPSHOT_GENERATION_PROPERTY_KEY);
    return v || "0";
  } catch (e) { return "0"; }
}
function bumpSnapshotGenerationStamp_() {
  try {
    PropertiesService.getScriptProperties().setProperty(SNAPSHOT_GENERATION_PROPERTY_KEY, String(new Date().getTime()));
  } catch (e) { /* non-fatal — worst case, cache behavior is exactly what it was before this fix */ }
}

// Splits a serialized string across as many "<key>_c0", "<key>_c1", ... keys
// as needed, plus a "<key>_meta" key recording the chunk count — so a
// Compact Summary of ANY size can be cached, not just ones under 100KB.
function cachePutChunked(cache, key, serialized, ttlSeconds) {
  try {
    var numChunks = Math.ceil(serialized.length / CACHE_CHUNK_SIZE) || 1;
    var batch = {};
    batch[key + "_meta"] = JSON.stringify({ numChunks: numChunks, totalLength: serialized.length });
    for (var i = 0; i < numChunks; i++) {
      batch[key + "_c" + i] = serialized.substr(i * CACHE_CHUNK_SIZE, CACHE_CHUNK_SIZE);
    }
    cache.putAll(batch, ttlSeconds);
  } catch (e) {
    // Non-fatal — caching is a performance optimization, not a requirement.
  }
}
function cacheGetChunked(cache, key) {
  try {
    var metaRaw = cache.get(key + "_meta");
    if (!metaRaw) return null;
    var meta = JSON.parse(metaRaw);
    var keys = [];
    for (var i = 0; i < meta.numChunks; i++) keys.push(key + "_c" + i);
    var chunkMap = cache.getAll(keys);
    var parts = [];
    for (var j = 0; j < meta.numChunks; j++) {
      var part = chunkMap[key + "_c" + j];
      if (part === undefined || part === null) return null; // a chunk expired independently — treat the whole entry as a miss
      parts.push(part);
    }
    return parts.join("");
  } catch (e) {
    return null;
  }
}

var SUMMARY_COLUMN_ALIASES = {
  awb:         ["رقم البوليصة", "رقم بوليصة", "AWB", "awb"],
  client:      ["الراسل", "العميل", "Client"],
  province:    ["المحافظة", "Province"],
  area:        ["المنطقة", "Area", "المنطقه"],
  branch:      ["فرع المنطقة", "فرع العضو", "الفرع", "Branch"],
  status:      ["حالة الشحنة", "حالة الشحنه", "Status"],
  finalStatus: ["الحالة النهائية", "الحالة النهائيه"],
  pickup:      ["تاريخ  استلام البيك أب  ", "تاريخ استلام البيك أب", "Pickup Date", "تاريخ الاستلام"],
  // CONFIRMED — no separate "Delivery Date" column exists in this
  // project's data (see docs/production-debug-fixes.md Bug #9 for the full
  // trail). This is not a guess: the project's OWN pre-existing Settings UI
  // text (index.html, SLA explanation panel) already states explicitly —
  // predating this session — "End Date = تاريخ آخر حالة (تُستخدم كأقرب
  // تقريب لتاريخ التسليم الفعلي لعدم وجود عمود منفصل لتاريخ التسليم في
  // الملف)". Both the backend's SUMMARY_COLUMN_ALIASES and the frontend's
  // independently-maintained COLUMN_ALIASES have only ever recognized
  // Pickup Date and Last Status Date — never a delivery-date field, across
  // every archived iteration of this project.
  // The alias list below is kept only as harmless, inert future-proofing:
  // if a real Delivery Date column is ever added to the sheet with one of
  // these header names (or any name you add here), it starts being used
  // automatically with zero further code changes — until then it matches
  // nothing and every row falls through to the Last Status Date fallback,
  // exactly matching the behavior the project already documented.
  delivery:    ["تاريخ التسليم", "تاريخ التسليم الفعلي", "Delivery Date"],
  lastStatus:  ["تاريخ اخر حالة", "تاريخ آخر حالة", "Last Status Date"],
  cod:         ["مبلغ التحصيل", "COD"],
  shipCost:    ["تكلفة الشحن", "Shipping Cost"]
};

var SUMMARY_STATUS_MAP = {
  delivered: ["تسليم ناجح", "التسليم ناجح"], // both spellings observed in real sheet data (June) map to the same bucket
  returned:  ["مرتجعات"],
  rejected:  ["رفض الاستلام و تم دفع الشحن", "رفض الاستلام و رفض والدفع"],
  pending:   ["قيد التشغيل", "قيد  التشغيل"]
};

var SUMMARY_DEFAULT_SLA_DAYS = 2;

// ============================================================
// 4C. PERSISTENT SLA SETTINGS (single source of truth)
// ============================================================
// Batch 1 fix: BRANCH_SLA_TARGETS/SLA_TARGET_DAYS previously lived ONLY as
// in-memory JS variables in index.html — reset to {} / 2 on every page
// reload, and never sent at all by the Management Analysis / Executive PDF
// pipeline (mgmtEnsureMonthsLoaded -> getMonthSummaryLite ->
// ensureMonthSummaryCached -> fetchMonthDashboardSummary), which silently
// fell back to SUMMARY_DEFAULT_SLA_DAYS for every branch. This is the ONE
// persisted source both the main dashboard and Management Analysis load
// their SLA configuration from — no separate/duplicate SLA config anywhere
// else. Stored via PropertiesService.getScriptProperties() (already the
// project's existing pattern — see SNAPSHOT_GENERATION_PROPERTY_KEY above),
// so it survives page reloads and is shared across every client session.
// This does NOT change SUMMARY_DEFAULT_SLA_DAYS itself, and does NOT change
// how getMonthDashboardSummary/getAllMonthsDashboardSummary resolve their
// OWN slaTargetDefault/branchSlaTargets from request params (still exactly
// as before, including their snapshot-compatibility comparisons against
// SUMMARY_DEFAULT_SLA_DAYS) — the frontend is responsible for loading these
// persisted values on boot and passing them as explicit request params on
// every request, on both the dashboard and Management Analysis paths alike.
// Fails open on any PropertiesService error, same pattern as the snapshot
// generation stamp: reads fall back to {slaTargetDefault: SUMMARY_DEFAULT_SLA_DAYS,
// branchSlaTargets: {}}, writes report success:false rather than throwing.
var SLA_SETTINGS_PROPERTY_KEY = "SLA_SETTINGS_JSON";

function getPersistedSlaSettings_() {
  var fallback = { slaTargetDefault: SUMMARY_DEFAULT_SLA_DAYS, branchSlaTargets: {} };
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SLA_SETTINGS_PROPERTY_KEY);
    if (!raw) return fallback;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    var target = (parsed.slaTargetDefault !== undefined && parsed.slaTargetDefault !== null && !isNaN(Number(parsed.slaTargetDefault)))
      ? Number(parsed.slaTargetDefault) : SUMMARY_DEFAULT_SLA_DAYS;
    var branchTargets = (parsed.branchSlaTargets && typeof parsed.branchSlaTargets === "object") ? parsed.branchSlaTargets : {};
    return { slaTargetDefault: target, branchSlaTargets: branchTargets };
  } catch (e) {
    console.log("[SLA SETTINGS READ FAILED] " + String(e && e.message ? e.message : e));
    return fallback;
  }
}

function getSlaSettingsPayload() {
  var settings = getPersistedSlaSettings_();
  return { success: true, slaTargetDefault: settings.slaTargetDefault, branchSlaTargets: settings.branchSlaTargets };
}

// Validates and persists {slaTargetDefault, branchSlaTargets} as ONE atomic
// JSON blob (never two separate keys) so a partial write can never leave
// the default and the per-branch overrides out of sync with each other.
function saveSlaSettingsPayload(params) {
  try {
    var targetRaw = params && params.slaTargetDefault;
    var target = (targetRaw !== undefined && targetRaw !== null && targetRaw !== "" && !isNaN(Number(targetRaw)) && Number(targetRaw) > 0)
      ? Number(targetRaw) : SUMMARY_DEFAULT_SLA_DAYS;

    var branchTargets = {};
    if (params && params.branchSlaTargets) {
      var parsed = JSON.parse(params.branchSlaTargets);
      if (parsed && typeof parsed === "object") {
        // Only keep finite, positive numeric overrides — never persist a
        // malformed/empty value that could later be misread as a real target.
        for (var branchName in parsed) {
          if (!Object.prototype.hasOwnProperty.call(parsed, branchName)) continue;
          var v = Number(parsed[branchName]);
          if (!isNaN(v) && v > 0) branchTargets[branchName] = v;
        }
      }
    }

    var toStore = { slaTargetDefault: target, branchSlaTargets: branchTargets };
    PropertiesService.getScriptProperties().setProperty(SLA_SETTINGS_PROPERTY_KEY, JSON.stringify(toStore));
    return { success: true, slaTargetDefault: target, branchSlaTargets: branchTargets };
  } catch (e) {
    console.log("[SLA SETTINGS SAVE FAILED] " + String(e && e.message ? e.message : e));
    return { success: false, error: String(e && e.message ? e.message : e) };
  }
}

function summaryNormText(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

function summaryDetectColumnMap(headers) {
  var map = {};
  var normHeaders = headers.map(function (h) { return summaryNormText(h); });
  var fields = Object.keys(SUMMARY_COLUMN_ALIASES);
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    var aliases = SUMMARY_COLUMN_ALIASES[field];
    var found = null;
    for (var a = 0; a < aliases.length; a++) {
      var normAlias = summaryNormText(aliases[a]);
      for (var h = 0; h < normHeaders.length; h++) {
        if (normHeaders[h] === normAlias) { found = headers[h]; break; }
      }
      if (found) break;
    }
    if (!found) {
      for (var a2 = 0; a2 < aliases.length; a2++) {
        var normAlias2 = summaryNormText(aliases[a2]);
        for (var h2 = 0; h2 < normHeaders.length; h2++) {
          if (normHeaders[h2].indexOf(normAlias2) !== -1 || normAlias2.indexOf(normHeaders[h2]) !== -1) { found = headers[h2]; break; }
        }
        if (found) break;
      }
    }
    if (found) map[field] = found;
  }
  return map;
}

var SUMMARY_STATUS_LOOKUP = null; // built once, lazily, on first use — see summaryClassifyStatus
// Arabic spelling-variant normalization — used ONLY for matching a status
// value against SUMMARY_STATUS_MAP (see docs/production-debug-fixes.md —
// Bug #8). Never applied to the `status` field stored on a row (that stays
// exactly as read from the sheet, trimmed only — see summaryNormText) —
// this only decides whether two different spellings of the SAME status
// already listed in SUMMARY_STATUS_MAP are recognized as equivalent. It
// never invents a new status->bucket mapping and never changes what an
// already-distinct status means.
function summaryNormalizeArabicForMatch_(value) {
  return String(value || '')
    .trim()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}
function summaryBuildStatusLookup() {
  var lookup = {};
  var buckets = Object.keys(SUMMARY_STATUS_MAP);
  for (var i = 0; i < buckets.length; i++) {
    // Returns (closed / open / on-hold) are classified by summaryClassifyKind(); rejection comes from the
    // «الحالة النهائية» column (see summaryEffectiveStatus_) — the status-text rejection list is used only when
    // SUMMARY_REJECT_FALLBACK_TO_STATUS is switched on.
    if (buckets[i] === "returned") continue;
    if (buckets[i] === "rejected" && !SUMMARY_REJECT_FALLBACK_TO_STATUS) continue;
    var vals = SUMMARY_STATUS_MAP[buckets[i]];
    for (var v = 0; v < vals.length; v++) {
      lookup[summaryNormalizeArabicForMatch_(summaryNormText(vals[v]))] = buckets[i];
    }
  }
  return lookup;
}
// ------------------------------------------------------------
// STATUS TAXONOMY (the 8 dashboard cards)
//   delivered      ← «حالة الشحنة» = تسليم ناجح
//   returnClosed   ← «حالة الشحنة» = مرتجعات / فيها «مغلق»
//   returnOpen     ← «حالة الشحنة» فيها «مرتجع» + «مفتوح»
//   returnHold     ← «حالة الشحنة» فيها «مرتجع» + «معلق»
//   inProgress     ← «حالة الشحنة» = قيد التشغيل
//   rejected       ← «الحالة النهائية» فيها «رفض»  (the ONE item read from the final-status column)
//   unknown        ← أي حالة غير مطابقة لما سبق (تظهر في كارت «غير مصنف» فقط إن وُجدت)
// A row whose final status is a rejection is counted ONCE, as rejected (it takes precedence over its status).
// The rejection is carried through the whole pipeline as an "effective status" label (prefix + final status), so
// the saved cube / filters / status breakdown stay consistent with the cards.
// ------------------------------------------------------------
var SUMMARY_REJECT_LABEL_PREFIX = "رفض (الحالة النهائية): ";
var SUMMARY_FINAL_REJECT_KEYWORDS = ["رفض"];
var SUMMARY_REJECT_FALLBACK_TO_STATUS = false; // true → a status text listed in SUMMARY_STATUS_MAP.rejected also counts as rejected
var SUMMARY_RETURN_KEYWORDS = ["مرتجع", "رجيع"];
var SUMMARY_RETURN_CLOSED_EXACT = ["مرتجعات"];
var SUMMARY_RETURN_CLOSED_KEYWORDS = ["مغلق"];
var SUMMARY_RETURN_OPEN_KEYWORDS = ["مفتوح"];
var SUMMARY_RETURN_HOLD_KEYWORDS = ["معلق"];

function summaryHasAnyKeyword_(norm, list) {
  for (var i = 0; i < list.length; i++) if (norm.indexOf(summaryNormalizeArabicForMatch_(list[i])) !== -1) return true;
  return false;
}
function summaryEffectiveStatus_(status, finalStatus) {
  var fs = summaryNormText(finalStatus);
  if (fs && summaryHasAnyKeyword_(summaryNormalizeArabicForMatch_(fs), SUMMARY_FINAL_REJECT_KEYWORDS)) return SUMMARY_REJECT_LABEL_PREFIX + fs;
  return summaryNormText(status);
}
function summaryClassifyKind(status) {
  if (!SUMMARY_STATUS_LOOKUP) SUMMARY_STATUS_LOOKUP = summaryBuildStatusLookup();
  var n = summaryNormalizeArabicForMatch_(summaryNormText(status));
  if (!n) return "unknown";
  if (n.indexOf(summaryNormalizeArabicForMatch_(SUMMARY_REJECT_LABEL_PREFIX)) === 0) return "rejected";
  if (SUMMARY_STATUS_LOOKUP.hasOwnProperty(n)) {
    var b = SUMMARY_STATUS_LOOKUP[n];
    return b === "pending" ? "inProgress" : b; // delivered | inProgress | rejected(fallback)
  }
  if (summaryHasAnyKeyword_(n, SUMMARY_RETURN_KEYWORDS)) {
    if (summaryHasAnyKeyword_(n, SUMMARY_RETURN_HOLD_KEYWORDS)) return "returnHold";
    if (summaryHasAnyKeyword_(n, SUMMARY_RETURN_OPEN_KEYWORDS)) return "returnOpen";
    for (var i = 0; i < SUMMARY_RETURN_CLOSED_EXACT.length; i++) if (n === summaryNormalizeArabicForMatch_(SUMMARY_RETURN_CLOSED_EXACT[i])) return "returnClosed";
    if (summaryHasAnyKeyword_(n, SUMMARY_RETURN_CLOSED_KEYWORDS)) return "returnClosed";
  }
  return "unknown";
}
function summaryKindToBucket_(kind) {
  if (kind === "returnClosed" || kind === "returnOpen" || kind === "returnHold") return "returned";
  if (kind === "inProgress") return "pending";
  return kind; // delivered | rejected | unknown
}
function summaryClassifyStatus(status) { return summaryKindToBucket_(summaryClassifyKind(status)); }

function summaryParseDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (Object.prototype.toString.call(v) === "[object Date]") return isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Computes the exact same KPI shape as the dashboard's computeKPIs(rows).
function summaryComputeKPIs(dedupRows, branchSlaTargets, slaTargetDefault) {
  var defaultTarget = (slaTargetDefault !== undefined && slaTargetDefault !== null && !isNaN(slaTargetDefault)) ? slaTargetDefault : SUMMARY_DEFAULT_SLA_DAYS;
  var total = dedupRows.length;
  var delivered = 0, returned = 0, rejected = 0, pending = 0, unknown = 0;
  var withinSla = 0, slaBreach = 0, deliveredWithDate = 0;
  var slaDaysArr = [];
  for (var i = 0; i < dedupRows.length; i++) {
    var r = dedupRows[i];
    if (r.bucket === "delivered") {
      delivered++;
      if (r.slaDays !== null) {
        deliveredWithDate++;
        slaDaysArr.push(r.slaDays);
        var target = (branchSlaTargets && branchSlaTargets[r.branch] !== undefined) ? branchSlaTargets[r.branch] : defaultTarget;
        if (r.slaDays <= target) withinSla++; else slaBreach++;
      }
    } else if (r.bucket === "returned") { returned++; }
    else if (r.bucket === "rejected") { rejected++; }
    else if (r.bucket === "pending") { pending++; }
    else { unknown++; }
  }
  var eligible = total - pending;
  var deliveryRate = total > 0 ? (delivered / total * 100) : null;
  var returnRate = eligible > 0 ? (returned / eligible * 100) : null;
  var rejectedRate = eligible > 0 ? (rejected / eligible * 100) : null;
  var successRate = total > 0 ? ((delivered + rejected) / total * 100) : null;
  var slaAchievement = deliveredWithDate > 0 ? (withinSla / deliveredWithDate * 100) : null;
  slaDaysArr.sort(function (a, b) { return a - b; });
  var avgDays = slaDaysArr.length ? (slaDaysArr.reduce(function (a, b) { return a + b; }, 0) / slaDaysArr.length) : null;
  var medianDays = slaDaysArr.length ? slaDaysArr[Math.floor(slaDaysArr.length / 2)] : null;
  var maxDays = slaDaysArr.length ? slaDaysArr[slaDaysArr.length - 1] : null;
  return {
    total: total, delivered: delivered, returned: returned, rejected: rejected, pending: pending, unknown: unknown,
    eligible: eligible, deliveryRate: deliveryRate, returnRate: returnRate, rejectedRate: rejectedRate,
    successRate: successRate, withinSla: withinSla, slaBreach: slaBreach, slaAchievement: slaAchievement,
    avgDays: avgDays, medianDays: medianDays, maxDays: maxDays, deliveredWithDate: deliveredWithDate
  };
}

// Groups already-deduped rows by a field, shaped exactly like the
// dashboard's groupBy(rows, field) output — so the client can render these
// straight into its existing branch/customer table & ranking functions.
function summaryGroupBy(dedupRows, field, topN, branchSlaTargets, slaTargetDefault) {
  var groups = {};
  var order = [];
  for (var i = 0; i < dedupRows.length; i++) {
    var r = dedupRows[i];
    var key = r[field];
    if (!key) continue;
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(r);
  }
  var out = [];
  for (var g = 0; g < order.length; g++) {
    var key2 = order[g];
    var k = summaryComputeKPIs(groups[key2], branchSlaTargets, slaTargetDefault);
    out.push({
      name: key2, shipments: k.total, delivered: k.delivered, deliveryRate: k.deliveryRate,
      returned: k.returned, returnRate: k.returnRate, rejected: k.rejected, rejectedRate: k.rejectedRate,
      successRate: k.successRate, avgDays: k.avgDays, withinSla: k.withinSla, slaBreach: k.slaBreach, slaPct: k.slaAchievement,
      pending: k.pending
    });
  }
  out.sort(function (a, b) { return b.shipments - a.shipments; });
  if (topN && out.length > topN) out = out.slice(0, topN);
  return out;
}

// ------------------------------------------------------------
// Time-series aggregation (daily/weekly/monthly) for the Growth/Trend tab —
// same shape as the client's trendData(rows, granularity): {label, shipments,
// delivered, returned, deliveryRate, returnRate} per bucket, computed from
// the SAME filtered+deduped rows used everywhere else in this response.
// weekKey mirrors the client's weekKey(d) formula exactly (ISO-ish week
// number: days since Jan 1 plus Jan 1's weekday offset, /7, ceil).
// ------------------------------------------------------------
function summaryWeekKey(d) {
  var oneJan = new Date(d.getFullYear(), 0, 1);
  var week = Math.ceil((((d.getTime() - oneJan.getTime()) / 86400000) + oneJan.getDay() + 1) / 7);
  return d.getFullYear() + "-W" + (week < 10 ? "0" + week : String(week));
}
function summaryMonthKey(d) {
  var mm = d.getMonth() + 1;
  return d.getFullYear() + "-" + (mm < 10 ? "0" + mm : String(mm));
}
function summaryBuildTimeSeries(dedupRows, granularity) {
  var keyFn = granularity === "weekly" ? summaryWeekKey : granularity === "monthly" ? summaryMonthKey
    : function (d) { return Utilities.formatDate(d, Session.getScriptTimeZone() || "Africa/Cairo", "yyyy-MM-dd"); };
  var buckets = {};
  var order = [];
  for (var i = 0; i < dedupRows.length; i++) {
    var r = dedupRows[i];
    if (!r.pickup) continue;
    var key = keyFn(r.pickup);
    if (!buckets[key]) { buckets[key] = []; order.push(key); }
    buckets[key].push(r);
  }
  order.sort();
  var out = [];
  for (var o = 0; o < order.length; o++) {
    var key2 = order[o];
    var k = summaryComputeKPIs(buckets[key2], null, null); // trend never needs SLA-target fields
    out.push({ label: key2, shipments: k.total, delivered: k.delivered, returned: k.returned,
      deliveryRate: k.deliveryRate, returnRate: k.returnRate });
  }
  return out;
}

// ------------------------------------------------------------
// Generic multi-dimension filtering (province/area/branch/client/status
// /attempt + pickup date range), used by getMonthDashboardSummary below.
// Mirrors the semantics of the dashboard's client-side getFilteredRowsInternal:
// each dimension is OR-matched against a list of selected values (empty/absent
// list = no filter on that dimension); excludeDims lets a dimension be skipped
// entirely (used to compute the attempt-distribution baseline the same way
// the client's getFilteredRowsExcluding('attemptCategory') does).
// ------------------------------------------------------------
// CANONICAL FILTER SANITIZATION (see docs/production-debug-fixes.md — Bug
// #4): a filter value list like [""] or [null] or ["  "] must be treated
// as NO filter on that dimension, never as an active filter that (because
// no real row has an empty-string branch) matches nothing. Every server
// routing decision downstream — hasServerFilters in both
// getMonthDashboardSummary and getAllMonthsDashboardSummary, Filter Cube
// usage (getMonthDashboardSummaryFromCube_ / summaryComputeFromCube_ /
// summaryCubeRecordMatchesFilters_), and the live per-row predicate
// (summaryRowMatchesFilters) — all read whatever summaryParseFilters()
// returns, so sanitizing once here is the single choke point; every caller
// gets the fix automatically without being touched individually.
// Rules: strings are trimmed; "", whitespace-only, null and undefined
// entries are dropped from each dimension's array. Every other value is
// kept exactly as-is — including legitimate values that merely look falsy
// (0, false) — this only ever drops entries that are empty/absent, never
// values that happen to be falsy.
function sanitizeFilters_(filters) {
  var out = {};
  if (!filters || typeof filters !== "object") return out;
  var keys = Object.keys(filters);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = filters[key];
    if (!Array.isArray(val)) { out[key] = val; continue; } // non-array filter values (if any) pass through untouched
    var cleaned = [];
    for (var j = 0; j < val.length; j++) {
      var item = val[j];
      if (item === null || item === undefined) continue;
      if (typeof item === "string") {
        var trimmed = summaryNormText(item);
        if (trimmed === "") continue;
        cleaned.push(trimmed);
        continue;
      }
      cleaned.push(item); // non-string (number incl. 0, boolean incl. false, etc.) — never dropped
    }
    out[key] = cleaned;
  }
  return out;
}
function summaryParseFilters(params) {
  var filters = {};
  if (params && params.filters) {
    try {
      var parsed = JSON.parse(params.filters);
      if (parsed && typeof parsed === "object") filters = parsed;
    } catch (e) { /* malformed filters JSON — treat as no filters */ }
  }
  // Legacy single-branch param (still used by existing Management Analysis
  // drill-down calls) — only applied if the newer `filters` param didn't
  // already specify a branch list.
  if ((!filters.branch || !filters.branch.length) && params && params.branch) {
    filters.branch = [summaryNormText(params.branch)];
  }
  return sanitizeFilters_(filters);
}

function summaryClassifyAttempt(slaDays, t1, t2) {
  if (slaDays === null || slaDays === undefined) return "na";
  if (slaDays <= t1) return "first";
  if (slaDays <= t2) return "second";
  return "other";
}

function summaryApplyFilters(dedupRows, filters, excludeDims, dateFrom, dateTo) {
  excludeDims = excludeDims || [];
  function active(dim) {
    return excludeDims.indexOf(dim) === -1 && filters[dim] && filters[dim].length;
  }
  function matches(val, list) {
    for (var i = 0; i < list.length; i++) { if (list[i] === val) return true; }
    return false;
  }
  var fromTime = dateFrom ? new Date(dateFrom + "T00:00:00").getTime() : null;
  var toTime = dateTo ? new Date(dateTo + "T23:59:59").getTime() : null;
  var useDate = excludeDims.indexOf("date") === -1 && (fromTime !== null || toTime !== null);

  return dedupRows.filter(function (r) {
    if (active("province") && !matches(r.province, filters.province)) return false;
    if (active("area") && !matches(r.area, filters.area)) return false;
    if (active("branch") && !matches(r.branch, filters.branch)) return false;
    if (active("client") && !matches(r.client, filters.client)) return false;
    if (active("status") && !matches(r.status, filters.status)) return false;
    if (active("attempt") && !matches(r.attemptCat, filters.attempt)) return false;
    if (useDate) {
      var t = r.pickup ? r.pickup.getTime() : null;
      if (t === null) return false;
      if (fromTime !== null && t < fromTime) return false;
      if (toTime !== null && t > toTime) return false;
    }
    return true;
  });
}

function summaryObjKeysSorted(obj) {
  var keys = [];
  for (var k in obj) { if (obj.hasOwnProperty(k)) keys.push(k); }
  keys.sort();
  return keys;
}
// Turns the {status: count} tally into a sorted array for the Data Quality
// "Unknown Status Details" table (see docs/production-debug-fixes.md — Bug
// #7): which exact raw status strings are landing in "unknown", how many
// shipments each, and what % of the total unknown count they represent —
// so "Unknown = 1,250" is never just an opaque number.
function summaryUnknownStatusBreakdown_(countsObj) {
  var total = 0;
  for (var k in countsObj) { if (countsObj.hasOwnProperty(k)) total += countsObj[k]; }
  var out = [];
  for (var s in countsObj) {
    if (!countsObj.hasOwnProperty(s)) continue;
    var c = countsObj[s];
    out.push({ status: s, count: c, pct: total > 0 ? (c / total * 100) : null });
  }
  out.sort(function (a, b) { return b.count - a.count; });
  return out;
}

function summaryHashKey(s) {
  // Short, stable digest for cache keys — filters JSON can be long, and
  // CacheService keys are length-capped.
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s);
  return digest.map(function (b) { return (b < 0 ? b + 256 : b).toString(16); }).join("");
}

// ------------------------------------------------------------
// Single-pass aggregation engine (performance hotfix).
// Previously: summaryApplyFilters/summaryComputeKPIs/summaryGroupBy/
// summaryBuildTimeSeries were each called separately (branch/customer/
// province/area/timeSeries-daily/weekly/monthly/attempt-baseline), meaning
// ~15-20 full linear passes over the deduped month for a single request.
// These helpers replace that with exactly ONE aggregation pass: a single
// accumulator object per group/bucket, updated once per row, finalized
// (cheap — proportional to the number of DISTINCT groups, not rows) only at
// the end. The old summaryApplyFilters/summaryComputeKPIs/summaryGroupBy/
// summaryBuildTimeSeries functions above are kept (unused by the hot path
// now) rather than deleted, to keep this change minimal and reviewable.
// ------------------------------------------------------------
function summaryNewGroupAcc() {
  return { total: 0, delivered: 0, returned: 0, returnClosed: 0, returnOpen: 0, returnHold: 0, rejected: 0, pending: 0, unknown: 0,
    withinSla: 0, slaBreach: 0, sumSlaDays: 0, deliveredWithDate: 0 };
}
function summaryAccumulateRow(acc, r, target) {
  acc.total++;
  if (r.bucket === "delivered") {
    acc.delivered++;
    if (r.slaDays !== null) {
      acc.deliveredWithDate++;
      acc.sumSlaDays += r.slaDays;
      if (r.slaDays <= target) acc.withinSla++; else acc.slaBreach++;
    }
  } else if (r.bucket === "returned") { acc.returned++; if (r.kind === "returnClosed") acc.returnClosed++; else if (r.kind === "returnOpen") acc.returnOpen++; else if (r.kind === "returnHold") acc.returnHold++; }
  else if (r.bucket === "rejected") { acc.rejected++; }
  else if (r.bucket === "pending") { acc.pending++; }
  else { acc.unknown++; }
}
function summaryFinalizeGroup(name, acc) {
  var total = acc.total;
  var eligible = total - acc.pending;
  var deliveryRate = total > 0 ? (acc.delivered / total * 100) : null;
  var returnRate = eligible > 0 ? (acc.returned / eligible * 100) : null;
  var rejectedRate = eligible > 0 ? (acc.rejected / eligible * 100) : null;
  var successRate = total > 0 ? ((acc.delivered + acc.rejected) / total * 100) : null;
  var slaAchievement = acc.deliveredWithDate > 0 ? (acc.withinSla / acc.deliveredWithDate * 100) : null;
  var avgDays = acc.deliveredWithDate > 0 ? (acc.sumSlaDays / acc.deliveredWithDate) : null;
  return {
    name: name, shipments: total, delivered: acc.delivered, deliveryRate: deliveryRate,
    returned: acc.returned, returnRate: returnRate, rejected: acc.rejected, rejectedRate: rejectedRate,
    successRate: successRate, avgDays: avgDays, withinSla: acc.withinSla, slaBreach: acc.slaBreach, slaPct: slaAchievement,
    pending: acc.pending
  };
}
function summaryFinalizeGroupList(accMap, order, topN) {
  var out = [];
  for (var i = 0; i < order.length; i++) out.push(summaryFinalizeGroup(order[i], accMap[order[i]]));
  out.sort(function (a, b) { return b.shipments - a.shipments; });
  if (topN && out.length > topN) out = out.slice(0, topN);
  return out;
}
function summaryFinalizeTimeSeries(map, order) {
  var sortedKeys = order.slice().sort();
  var out = [];
  for (var i = 0; i < sortedKeys.length; i++) {
    var key = sortedKeys[i];
    var b = map[key];
    var eligible = b.shipments - b.pending;
    var deliveryRate = b.shipments > 0 ? (b.delivered / b.shipments * 100) : null;
    var returnRate = eligible > 0 ? (b.returned / eligible * 100) : null;
    out.push({ label: key, shipments: b.shipments, delivered: b.delivered, returned: b.returned,
      deliveryRate: deliveryRate, returnRate: returnRate });
  }
  return out;
}

// ------------------------------------------------------------
// FILTERABLE SUMMARY V2 — query engine over a saved cube (Code.gs
// filterCube, built once per persistent-build; see getMonthDashboardSummary
// above). Record shape: [provinceIdx, areaIdx, branchIdx, clientIdx,
// statusIdx, attemptIdx, pickupDateStr, count, withinSla, slaBreach,
// sumSlaDays, deliveredWithDate, maxSlaDays, sumCod, sumShipCost].
// ------------------------------------------------------------
var CUBE_ATTEMPT_KEYS = ["first", "second", "other", "na"];

function summaryCubeRecordMatchesFilters_(rec, dict, filters, excludeDim, fromTime, toTime) {
  function active(dim) { return dim !== excludeDim && filters[dim] && filters[dim].length; }
  if (active("province") && !summaryFilterListMatches(dict.province[rec[0]], filters.province)) return false;
  if (active("area") && !summaryFilterListMatches(dict.area[rec[1]], filters.area)) return false;
  if (active("branch") && !summaryFilterListMatches(dict.branch[rec[2]], filters.branch)) return false;
  if (active("client") && !summaryFilterListMatches(dict.client[rec[3]], filters.client)) return false;
  if (active("status") && !summaryFilterListMatches(dict.status[rec[4]], filters.status)) return false;
  if (active("attempt") && !summaryFilterListMatches(CUBE_ATTEMPT_KEYS[rec[5]], filters.attempt)) return false;
  if (excludeDim !== "date" && (fromTime !== null || toTime !== null)) {
    if (!rec[6]) return false; // record has no pickup date — excluded from any date-bounded query, same as a raw row with no pickup date
    var t = new Date(rec[6] + "T00:00:00").getTime();
    if (fromTime !== null && t < fromTime) return false;
    if (toTime !== null && t > toTime) return false;
  }
  return true;
}
function summaryAccumulateCubeRecord_(acc, rec, bucket, kind) {
  var n = rec[7];
  acc.total += n;
  if (bucket === "delivered") {
    acc.delivered += n;
    acc.deliveredWithDate += rec[11];
    acc.sumSlaDays += rec[10];
    acc.withinSla += rec[8];
    acc.slaBreach += rec[9];
  } else if (bucket === "returned") { acc.returned += n; if (kind === "returnClosed") acc.returnClosed += n; else if (kind === "returnOpen") acc.returnOpen += n; else if (kind === "returnHold") acc.returnHold += n; }
  else if (bucket === "rejected") { acc.rejected += n; }
  else if (bucket === "pending") { acc.pending += n; }
  else { acc.unknown += n; }
}
function summaryCubeWeekKey_(dateStr) {
  return summaryWeekKey(new Date(dateStr + "T00:00:00"));
}

// cubes: array of {dict, records} — length 1 for a single month, length N
// for an All-Months filtered query. Returns the FILTERED portion of the
// dashboard-summary contract only (kpis/attemptSummary/branch-customer-
// province-area summaries/statusSummary/trend/timeSeries/totalCod/
// totalShipCost) — the caller overlays this on top of the snapshot's own
// UNFILTERED grandTotal/totalRows/dataQuality/facets/colMap, exactly as the
// live aggregation path already separates "filtered kpis.total" from
// "unfiltered grandTotal" (used by the frontend to always anchor rates to
// the whole month, not the filtered subset).
function summaryComputeFromCube_(cubes, filters, dateFrom, dateTo) {
  var fromTime = dateFrom ? new Date(dateFrom + "T00:00:00").getTime() : null;
  var toTime = dateTo ? new Date(dateTo + "T23:59:59").getTime() : null;

  var topAcc = summaryNewGroupAcc();
  var topMaxDays = null;
  var branchAccMap = {}, branchOrder = [];
  var customerAccMap = {}, customerOrder = [];
  var provinceAccMap = {}, provinceOrder = [];
  var areaAccMap = {}, areaOrder = [];
  var statusSummary = {};
  var totalCod = 0, totalShipCost = 0;
  var dailyMap = {}, dailyOrder = [];
  var weeklyMap = {}, weeklyOrder = [];
  var monthlyMap = {}, monthlyOrder = [];
  var attemptSummary = { first: 0, second: 0, other: 0, na: 0, total: 0 };
  var trendMapFiltered = {};

  function ensureAcc(map, order, key) { if (!map[key]) { map[key] = summaryNewGroupAcc(); order.push(key); } return map[key]; }
  function ensureTimeAcc(map, order, key) { if (!map[key]) { map[key] = { shipments: 0, delivered: 0, returned: 0, pending: 0 }; order.push(key); } return map[key]; }
  function bumpTimeAcc(acc, bucket) {
    acc.shipments++;
    if (bucket === "delivered") acc.delivered++; else if (bucket === "returned") acc.returned++; else if (bucket === "pending") acc.pending++;
  }
  function bumpTimeAccBy(acc, bucket, n) {
    acc.shipments += n;
    if (bucket === "delivered") acc.delivered += n; else if (bucket === "returned") acc.returned += n; else if (bucket === "pending") acc.pending += n;
  }

  for (var ci = 0; ci < cubes.length; ci++) {
    var dict = cubes[ci].dict, records = cubes[ci].records;
    for (var ri = 0; ri < records.length; ri++) {
      var rec = records[ri];
      var attemptKey = CUBE_ATTEMPT_KEYS[rec[5]];

      var baselineMatch = summaryCubeRecordMatchesFilters_(rec, dict, filters, "attempt", fromTime, toTime);
      if (baselineMatch) { attemptSummary.total += rec[7]; attemptSummary[attemptKey] += rec[7]; }

      if (!summaryCubeRecordMatchesFilters_(rec, dict, filters, null, fromTime, toTime)) continue;

      var status = dict.status[rec[4]];
      var kind = summaryClassifyKind(status);
      var bucket = summaryKindToBucket_(kind);
      var branchName = dict.branch[rec[2]], clientName = dict.client[rec[3]],
        provinceName = dict.province[rec[0]], areaName = dict.area[rec[1]];

      summaryAccumulateCubeRecord_(topAcc, rec, bucket, kind);
      if (bucket === "delivered" && (rec[8] + rec[9]) > 0 && (topMaxDays === null || rec[12] > topMaxDays)) topMaxDays = rec[12];

      summaryAccumulateCubeRecord_(ensureAcc(branchAccMap, branchOrder, branchName), rec, bucket, kind);
      summaryAccumulateCubeRecord_(ensureAcc(customerAccMap, customerOrder, clientName), rec, bucket, kind);
      summaryAccumulateCubeRecord_(ensureAcc(provinceAccMap, provinceOrder, provinceName), rec, bucket, kind);
      summaryAccumulateCubeRecord_(ensureAcc(areaAccMap, areaOrder, areaName), rec, bucket, kind);

      statusSummary[status] = (statusSummary[status] || 0) + rec[7];
      totalCod += rec[13]; totalShipCost += rec[14];

      if (rec[6]) {
        var dayKey = rec[6];
        if (!trendMapFiltered[dayKey]) trendMapFiltered[dayKey] = { date: dayKey, count: 0, delivered: 0 };
        trendMapFiltered[dayKey].count += rec[7];
        if (bucket === "delivered") trendMapFiltered[dayKey].delivered += rec[7];

        bumpTimeAccBy(ensureTimeAcc(dailyMap, dailyOrder, dayKey), bucket, rec[7]);
        bumpTimeAccBy(ensureTimeAcc(weeklyMap, weeklyOrder, summaryCubeWeekKey_(dayKey)), bucket, rec[7]);
        bumpTimeAccBy(ensureTimeAcc(monthlyMap, monthlyOrder, dayKey.slice(0, 7)), bucket, rec[7]);
      }
    }
  }

  var topEligible = topAcc.total - topAcc.pending;
  var kpis = {
    total: topAcc.total, delivered: topAcc.delivered, returned: topAcc.returned, returnClosed: topAcc.returnClosed, returnOpen: topAcc.returnOpen, returnHold: topAcc.returnHold, rejected: topAcc.rejected,
    pending: topAcc.pending, unknown: topAcc.unknown, eligible: topEligible,
    deliveryRate: topAcc.total > 0 ? (topAcc.delivered / topAcc.total * 100) : null,
    returnRate: topEligible > 0 ? (topAcc.returned / topEligible * 100) : null,
    rejectedRate: topEligible > 0 ? (topAcc.rejected / topEligible * 100) : null,
    successRate: topAcc.total > 0 ? ((topAcc.delivered + topAcc.rejected) / topAcc.total * 100) : null,
    withinSla: topAcc.withinSla, slaBreach: topAcc.slaBreach,
    slaAchievement: topAcc.deliveredWithDate > 0 ? (topAcc.withinSla / topAcc.deliveredWithDate * 100) : null,
    avgDays: topAcc.deliveredWithDate > 0 ? (topAcc.sumSlaDays / topAcc.deliveredWithDate) : null,
    medianDays: null, // not reconstructable from grouped cube data (same documented limitation as the All-Months merge) — never faked
    maxDays: topMaxDays,
    deliveredWithDate: topAcc.deliveredWithDate
  };

  var trend = [];
  for (var tKey in trendMapFiltered) { if (trendMapFiltered.hasOwnProperty(tKey)) trend.push(trendMapFiltered[tKey]); }
  trend.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  return {
    kpis: kpis,
    attemptSummary: attemptSummary,
    branchSummary: summaryFinalizeGroupList(branchAccMap, branchOrder, 3000),
    customerSummary: summaryFinalizeGroupList(customerAccMap, customerOrder, 3000),
    provinceSummary: summaryFinalizeGroupList(provinceAccMap, provinceOrder, 1000),
    areaSummary: summaryFinalizeGroupList(areaAccMap, areaOrder, 1000),
    statusSummary: statusSummary,
    trend: trend,
    timeSeries: {
      daily: summaryFinalizeTimeSeries(dailyMap, dailyOrder),
      weekly: summaryFinalizeTimeSeries(weeklyMap, weeklyOrder),
      monthly: summaryFinalizeTimeSeries(monthlyMap, monthlyOrder)
    },
    totalCod: totalCod, totalShipCost: totalShipCost
  };
}

// Attempts the fast cube-based filtered path for ONE month. Returns null
// (signal to fall back to live raw-row aggregation) when no compatible
// (v2+) cube is available for this month — e.g. an old snapshot that
// predates Filterable Summary V2, or a month never built yet.
function summaryBranchTargetsEqual_(a, b) {
  // A plain JSON.stringify(a) === JSON.stringify(b) comparison is sensitive
  // to key INSERTION ORDER, not just content — two branchSlaTargets objects
  // with the exact same branch->target values could compare as different
  // (or, in edge cases, mask a real difference) purely because of the
  // order keys were added in (e.g. the frontend builds this object by
  // iterating table rows sorted by shipment volume, which can differ
  // between requests). Compare by key/value content instead.
  a = a || {}; b = b || {};
  try {
    var ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (var i = 0; i < ak.length; i++) {
      var k = ak[i];
      if (!b.hasOwnProperty(k)) return false;
      if (Number(a[k]) !== Number(b[k])) return false;
    }
    return true;
  } catch (e) { return false; }
}
function getMonthDashboardSummaryFromCube_(sheetName, filters, dateFrom, dateTo, attemptT1, attemptT2, slaTargetDefault, branchSlaTargets) {
  var snap = getSavedMonthSummary_(sheetName);
  if (!snap || !snap.filterCube || !snap.filterCube.records) return null;
  // Compatibility check (the actual fix): attemptCat and withinSla/slaBreach
  // were classified ONCE, at build time, using the cube's own buildConfig.
  // They cannot be exactly reclassified later from aggregated sums alone —
  // a stale cube must never be used for a request with different settings.
  var bc = snap.filterCube.buildConfig;
  if (!bc ||
      Number(bc.attemptT1) !== Number(attemptT1) ||
      Number(bc.attemptT2) !== Number(attemptT2) ||
      Number(bc.slaTargetDefault) !== Number(slaTargetDefault) ||
      !summaryBranchTargetsEqual_(bc.branchSlaTargets, branchSlaTargets)) {
    console.log("[FILTER CUBE INCOMPATIBLE] " + JSON.stringify({ sheet: sheetName, cubeConfig: bc, requested: { attemptT1: attemptT1, attemptT2: attemptT2, slaTargetDefault: slaTargetDefault, branchSlaTargets: branchSlaTargets } }));
    return null; // triggers the existing live-aggregation fallback — never a silently-wrong result
  }
  var computed = summaryComputeFromCube_([snap.filterCube], filters, dateFrom, dateTo);
  var result = {
    success: true, sheet: sheetName, source: MONTH_SOURCE[sheetName],
    branchFilter: (filters.branch && filters.branch.length === 1) ? filters.branch[0] : null,
    filtersApplied: filters, empty: false, noData: false,
    totalRows: snap.totalRows, grandTotal: snap.grandTotal,
    generatedAt: new Date().toISOString(),
    kpis: computed.kpis, attemptSummary: computed.attemptSummary,
    dq: { totalRows: computed.kpis.total, distinctAwb: computed.kpis.total, dupAwbCount: snap.dataQuality.dupAwbCount, invalidDates: snap.dataQuality.invalidDates },
    totalCod: computed.totalCod, totalShipCost: computed.totalShipCost,
    branchSummary: computed.branchSummary, customerSummary: computed.customerSummary,
    provinceSummary: computed.provinceSummary, areaSummary: computed.areaSummary,
    statusSummary: computed.statusSummary, finalStatusSummary: {}, // not tracked per cube record — documented limitation, not one of the required filter dimensions
    trend: computed.trend, timeSeries: computed.timeSeries,
    dataQuality: snap.dataQuality, colMap: snap.colMap, facets: snap.facets,
    cached: false, filteredFromCube: true
  };
  return result;
}

// Single-row filter predicate — same semantics as summaryApplyFilters, but
// evaluated once per row inline in the aggregation loop instead of
// allocating a filtered copy of the array per call site. No inner closures
// (this runs twice per row in the aggregation pass — closures allocated
// per-call would mean ~2x117k extra function objects on a large month).
function summaryFilterListMatches(val, list) {
  for (var i = 0; i < list.length; i++) { if (list[i] === val) return true; }
  return false;
}
function summaryRowMatchesFilters(r, filters, excludeDim, fromTime, toTime) {
  if (excludeDim !== "province" && filters.province && filters.province.length && !summaryFilterListMatches(r.province, filters.province)) return false;
  if (excludeDim !== "area" && filters.area && filters.area.length && !summaryFilterListMatches(r.area, filters.area)) return false;
  if (excludeDim !== "branch" && filters.branch && filters.branch.length && !summaryFilterListMatches(r.branch, filters.branch)) return false;
  if (excludeDim !== "client" && filters.client && filters.client.length && !summaryFilterListMatches(r.client, filters.client)) return false;
  if (excludeDim !== "status" && filters.status && filters.status.length && !summaryFilterListMatches(r.status, filters.status)) return false;
  if (excludeDim !== "attempt" && filters.attempt && filters.attempt.length && !summaryFilterListMatches(r.attemptCat, filters.attempt)) return false;
  if (excludeDim !== "date" && (fromTime !== null || toTime !== null)) {
    var t = r.pickup ? r.pickup.getTime() : null;
    if (t === null) return false;
    if (fromTime !== null && t < fromTime) return false;
    if (toTime !== null && t > toTime) return false;
  }
  return true;
}
function summaryFormatDuplicateRecord(r) {
  var tz = Session.getScriptTimeZone() || "Africa/Cairo";
  return {
    awb: r.awb, client: r.client, status: r.status, branch: r.branch,
    pickup: r.pickup ? Utilities.formatDate(r.pickup, tz, "yyyy-MM-dd") : "",
    lastStatus: r.lastStatus ? Utilities.formatDate(r.lastStatus, tz, "yyyy-MM-dd") : ""
  };
}
// Hoisted per-row helpers for the normalize pass — plain functions with no
// closure over `row`/`idx`, called ~117k times on a large month. Avoids
// allocating a new function object on every iteration (as the previous
// per-row `row.every(function(c){...})` / `var get = function(field){...}`
// pattern did).
function summaryRowIsAllEmpty(row) {
  for (var i = 0; i < row.length; i++) {
    var c = row[i];
    if (c !== null && c !== "" && c !== undefined) return false;
  }
  return true;
}
function summaryGetField(row, idx, field) {
  var i = idx[field];
  return (i !== undefined && i >= 0) ? row[i] : null;
}

function getMonthDashboardSummary(sheetName, params) {

  var tStart = new Date().getTime();

  if (!MONTH_SOURCE.hasOwnProperty(sheetName)) {
    return { success: false, error: "شهر غير معروف: " + sheetName };
  }

  // Normal dashboard viewing with NO active server-side filters uses the
  // pre-built persistent snapshot. Refresh does NOT trigger raw aggregation.
  // A build request explicitly sets __buildPersistentSummary=1 and bypasses this.
  var isPersistentBuild = !!(params && params.__buildPersistentSummary);
  var requestedFilters = summaryParseFilters(params);
  // Snapshot is valid for the normal unfiltered month view. Runtime SLA/attempt
  // settings are deliberately NOT treated as filters here; they are part of the
  // snapshot build configuration. Actual dimension/date filters still use the
  // existing live compact aggregation path so no raw rows ever reach the browser.
  var hasServerFilters = Object.keys(requestedFilters).some(function(k){
    return Array.isArray(requestedFilters[k]) && requestedFilters[k].length > 0;
  }) || !!(params && (params.dateFrom || params.dateTo || summaryNormText(params.branch)));

  var filters = requestedFilters;
  var attemptT1 = (params && params.attemptT1 !== undefined && params.attemptT1 !== "") ? parseFloat(params.attemptT1) : 1;
  var attemptT2 = (params && params.attemptT2 !== undefined && params.attemptT2 !== "") ? parseFloat(params.attemptT2) : 2;
  if (isNaN(attemptT1)) attemptT1 = 1;
  if (isNaN(attemptT2)) attemptT2 = 2;
  var slaTargetDefault = (params && params.slaTarget !== undefined && params.slaTarget !== "") ? parseFloat(params.slaTarget) : SUMMARY_DEFAULT_SLA_DAYS;
  if (isNaN(slaTargetDefault)) slaTargetDefault = SUMMARY_DEFAULT_SLA_DAYS;
  var branchSlaTargets = {};
  if (params && params.branchSlaTargets) {
    try {
      var parsedTargets = JSON.parse(params.branchSlaTargets);
      if (parsedTargets && typeof parsedTargets === "object") branchSlaTargets = parsedTargets;
    } catch (eTargets) { /* malformed — fall back to {} (default target for every branch) */ }
  }

  if (!isPersistentBuild && !hasServerFilters) {
    var savedSnapshot = getSavedMonthSummary_(sheetName);
    if (savedSnapshot) {
      var snapBc = savedSnapshot.filterCube && savedSnapshot.filterCube.buildConfig;
      var snapshotConfigMatches = snapBc &&
        Number(snapBc.attemptT1) === Number(attemptT1) &&
        Number(snapBc.attemptT2) === Number(attemptT2) &&
        Number(snapBc.slaTargetDefault) === Number(slaTargetDefault) &&
        summaryBranchTargetsEqual_(snapBc.branchSlaTargets, branchSlaTargets);
      // A snapshot with no buildConfig at all predates this check (an old
      // v2 snapshot saved before this fix) — treated as compatible only
      // when the request uses the plain defaults, matching prior behavior;
      // any non-default request still falls through to live aggregation.
      var legacyDefaultsRequested = !snapBc && attemptT1 === 1 && attemptT2 === 2 &&
        slaTargetDefault === SUMMARY_DEFAULT_SLA_DAYS && summaryBranchTargetsEqual_({}, branchSlaTargets);
      if (snapshotConfigMatches || legacyDefaultsRequested) {
        savedSnapshot.cached = true;
        savedSnapshot.persistent = true;
        savedSnapshot.snapshot = true;
        return savedSnapshot;
      }
      console.log("[SNAPSHOT CONFIG INCOMPATIBLE] " + JSON.stringify({ sheet: sheetName, snapshotConfig: snapBc || null, requested: { attemptT1: attemptT1, attemptT2: attemptT2, slaTargetDefault: slaTargetDefault, branchSlaTargets: branchSlaTargets } }));
      // Falls through to live aggregation below — never returns the
      // snapshot's stale attemptSummary/withinSla/slaBreach in this case.
    }
  }

  var dateFrom = (params && params.dateFrom) ? params.dateFrom : "";
  var dateTo = (params && params.dateTo) ? params.dateTo : "";
  var branchFilter = (filters.branch && filters.branch.length === 1) ? filters.branch[0] : ""; // kept for legacy response field only
  // Performance hotfix: ?debug=1 always forces a fresh (non-cached) run so
  // the returned timings reflect a REAL computation, never a cache hit.
  var debugMode = !!(params && (params.debug === "1" || params.debug === "true"));
  var forceRefresh = debugMode || (params && (params.refresh === "1" || params.refresh === "true"));
  // Cache key includes EVERY input that affects the computed result — not
  // just filters/dates, but also the attempt-window and SLA-target settings
  // (these affect attemptSummary / slaPct / withinSla even when no other
  // filter is active) — see requirement: "Cache key must include sheet/month,
  // active filters, and SLA settings that affect calculations."
  var cacheKey = "dash_v3_" + sheetName + "_g" + getSnapshotGenerationStamp_() + "_p_" + summaryHashKey(
    JSON.stringify(filters) + "|" + dateFrom + "|" + dateTo + "|" +
    attemptT1 + "|" + attemptT2 + "|" + slaTargetDefault + "|" + JSON.stringify(branchSlaTargets)
  );
  var cache = CacheService.getScriptCache();

  if (!forceRefresh) {
    var cached = cacheGetChunked(cache, cacheKey);
    if (cached) {
      var cachedObj = JSON.parse(cached);
      cachedObj.cached = true;
      console.log("[CACHE HIT]" + (params.__requestId ? (" " + JSON.stringify({ requestId: params.__requestId, sheet: sheetName, cacheKey: cacheKey })) : ""));
      return cachedObj;
    }
  }

  if (!isPersistentBuild && hasServerFilters) {
    var cubeResult = getMonthDashboardSummaryFromCube_(sheetName, filters, dateFrom, dateTo, attemptT1, attemptT2, slaTargetDefault, branchSlaTargets);
    if (cubeResult) {
      try {
        var cubeSerialized = JSON.stringify(cubeResult);
        if (cubeSerialized.length < 3000000) cachePutChunked(cache, cacheKey, cubeSerialized, DASHBOARD_CACHE_TTL_SECONDS);
      } catch (eCubeCache) { /* non-fatal */ }
      console.log("[FILTER CUBE HIT] " + JSON.stringify({ requestId: params.__requestId || null, sheet: sheetName, filters: filters }));
      return cubeResult;
    }
    // No compatible cube for this month — fall through to live raw-row
    // aggregation below exactly as before Filterable Summary V2 existed.
  }

  var quarter = MONTH_SOURCE[sheetName];
  var spreadsheetId = SPREADSHEET_IDS[quarter];

  var tOpenStart = new Date().getTime();
  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (err) {
    return { success: false, error: "تعذر فتح Spreadsheet " + quarter + ": " + String(err && err.message ? err.message : err) };
  }
  var tOpenEnd = new Date().getTime();

  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    return { success: false, error: "الشيت غير موجود: " + sheetName + " داخل " + quarter };
  }
  var tLocateEnd = new Date().getTime();

  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  var tDimEnd = new Date().getTime();

  // Empty tab (no data yet) is a normal state, NOT an error — matches the
  // dashboard's existing "no data yet" handling exactly.
  if (lastRow === 0 || lastColumn === 0) {
    return { success: true, sheet: sheetName, source: quarter, empty: true, noData: true, totalRows: 0, grandTotal: 0, attemptSummary: { first:0, second:0, other:0, na:0, total:0 }, timeSeries: { daily:[], weekly:[], monthly:[] }, dataQuality: { totalRows:0, distinctAwb:0, dupAwbCount:0, invalidDates:0, missingBranch:0, missingClient:0, missingProvince:0, unknownStatusCount:0, unknownStatusList:[], unknownStatusBreakdown:[], missingSlaData:0, negativeCod:0, duplicateRecords:[], duplicateRecordsTruncated:false }, facets: { provinces:[], branches:[], clients:[], statuses:[], areasAll:[], areasByProvince:{} }, colMap: {}, generatedAt: new Date().toISOString() };
  }
  if (lastRow < 2) {
    return { success: true, sheet: sheetName, source: quarter, empty: true, noData: true, totalRows: 0, grandTotal: 0, attemptSummary: { first:0, second:0, other:0, na:0, total:0 }, timeSeries: { daily:[], weekly:[], monthly:[] }, dataQuality: { totalRows:0, distinctAwb:0, dupAwbCount:0, invalidDates:0, missingBranch:0, missingClient:0, missingProvince:0, unknownStatusCount:0, unknownStatusList:[], unknownStatusBreakdown:[], missingSlaData:0, negativeCod:0, duplicateRecords:[], duplicateRecordsTruncated:false }, facets: { provinces:[], branches:[], clients:[], statuses:[], areasAll:[], areasByProvince:{} }, colMap: {}, generatedAt: new Date().toISOString() };
  }

  // Single full read, done ONCE on the server — this is the whole point:
  // the heavy read happens here (fast, server-side), and only a small
  // aggregated JSON crosses the network to the browser, never the raw rows.
  // (Headers and data share this one call — there is no separate "read
  // headers" round trip to instrument; see debug.readMs below.)
  var tReadStart = new Date().getTime();
  var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var headers = values[0];
  var dataRows = values.slice(1);
  var tReadEnd = new Date().getTime();

  var hasAnyContent = dataRows.some(function (row) {
    return row.some(function (cell) { return cell !== "" && cell !== null; });
  });
  if (!hasAnyContent) {
    return { success: true, sheet: sheetName, source: quarter, empty: true, noData: true, totalRows: 0, grandTotal: 0, attemptSummary: { first:0, second:0, other:0, na:0, total:0 }, timeSeries: { daily:[], weekly:[], monthly:[] }, dataQuality: { totalRows:0, distinctAwb:0, dupAwbCount:0, invalidDates:0, missingBranch:0, missingClient:0, missingProvince:0, unknownStatusCount:0, unknownStatusList:[], unknownStatusBreakdown:[], missingSlaData:0, negativeCod:0, duplicateRecords:[], duplicateRecordsTruncated:false }, facets: { provinces:[], branches:[], clients:[], statuses:[], areasAll:[], areasByProvince:{} }, colMap: {}, generatedAt: new Date().toISOString() };
  }

  var tMapStart = new Date().getTime();
  var colMap = summaryDetectColumnMap(headers);
  var idx = {};
  var mappedFields = Object.keys(colMap);
  for (var mf = 0; mf < mappedFields.length; mf++) {
    idx[mappedFields[mf]] = headers.indexOf(colMap[mappedFields[mf]]);
  }
  var tMapEnd = new Date().getTime();

  // ============================================================
  // PASS 1 (normalize) — ONE loop over the raw sheet rows. Builds the
  // deduped AWB map, every Data Quality counter, the filter-dropdown facets,
  // AND captures duplicate-record detail — all fused into this single pass
  // (previously facets and duplicate-record capture were each a SEPARATE
  // full scan of the data).
  // ============================================================
  var tNormalizeStart = new Date().getTime();

  var awbMap = {}; // awb -> latest row object (dedup, matches dedupeForKPI)
  var dupCount = 0;
  var invalidDates = 0;
  var dqTotalRows = 0, missingBranch = 0, missingClient = 0, missingProvince = 0, negativeCod = 0, unknownStatusCount = 0, missingSlaData = 0;
  var unknownStatusSet = {};
  var seenAwbCount = {}; // awb -> occurrence count
  var fullyBlankRowCount = 0, blankAwbRowCount = 0;

  var DQ_MAX_DUPLICATE_RECORDS = 1000;
  var duplicateRecords = [];
  var duplicateRecordsTruncated = false;

  // Facets — distinct values per dimension, collected from every raw row
  // that has a valid AWB (duplicates just re-touch an already-seen key, so
  // scanning raw rows here — instead of the deduped set afterward — is
  // equivalent and saves a whole extra pass).
  var provinceSet = {}, branchSet = {}, clientSet = {}, statusSet = {}, areaSet = {};
  var areasByProvinceSets = {};

  for (var ri = 0; ri < dataRows.length; ri++) {
    var row = dataRows[ri];
    if (summaryRowIsAllEmpty(row)) { fullyBlankRowCount++; continue; }

    var awb = summaryNormText(summaryGetField(row, idx, "awb"));
    if (!awb) { blankAwbRowCount++; continue; }

    dqTotalRows++;
    seenAwbCount[awb] = (seenAwbCount[awb] || 0) + 1;

    var pickup = summaryParseDate(summaryGetField(row, idx, "pickup"));
    var lastStatus = summaryParseDate(summaryGetField(row, idx, "lastStatus"));
    var deliveryDate = summaryParseDate(summaryGetField(row, idx, "delivery"));
    if (!pickup) invalidDates++;

    var finalStatus = summaryNormText(summaryGetField(row, idx, "finalStatus"));
    var status = summaryEffectiveStatus_(summaryGetField(row, idx, "status"), finalStatus); // rejection comes from the final-status column
    var kind = summaryClassifyKind(status);
    var bucket = summaryKindToBucket_(kind);
    if (bucket === "unknown" && status) { unknownStatusSet[status] = (unknownStatusSet[status]||0) + 1; unknownStatusCount++; }
    var branch = summaryNormText(summaryGetField(row, idx, "branch"));
    if (!branch) missingBranch++;
    var client = summaryNormText(summaryGetField(row, idx, "client"));
    if (!client) missingClient++;
    var province = summaryNormText(summaryGetField(row, idx, "province"));
    if (!province) missingProvince++;
    var area = summaryNormText(summaryGetField(row, idx, "area"));
    var cod = parseFloat(summaryGetField(row, idx, "cod")) || 0;
    if (cod < 0) negativeCod++;
    var shipCost = parseFloat(summaryGetField(row, idx, "shipCost")) || 0;

    // ATTEMPT CATEGORY — UNCHANGED from before this fix. This is a separate,
    // pre-existing feature (drives the "Attempt Category" filter and
    // attemptSummary breakdown, see summaryClassifyAttempt/attemptSummary
    // below) that intentionally applies to EVERY row regardless of bucket —
    // it measures pickup-to-last-status timing generally, not delivery
    // performance specifically. It must NOT be affected by the Delivery
    // SLA end-date priority change below (an earlier draft of this fix
    // accidentally coupled the two, which would have silently reclassified
    // every non-delivered row's Attempt Category to "na" the moment it no
    // longer had a slaDays value — a real regression, caught before this
    // was ever shipped, not after).
    var attemptDays = null;
    if (pickup && lastStatus) attemptDays = (lastStatus.getTime() - pickup.getTime()) / 86400000;
    var attemptCat = summaryClassifyAttempt(attemptDays, attemptT1, attemptT2);

    // SLA END DATE PRIORITY (see docs/production-debug-fixes.md — Bug #9):
    // completely separate from attemptCat above — this is ONLY the
    // Delivery SLA achievement metric (section 6/8 of the request).
    // 1) Delivery Date, when present and valid — for ANY row (not gated on
    //    bucket, since a genuine Delivery Date is authoritative regardless).
    // 2) Last Status Date, ONLY as a fallback, and ONLY when the shipment
    //    is actually Delivered — never applied to returned/rejected/
    //    pending/unknown rows.
    var slaEndDate = null, slaEndSource = null;
    if (deliveryDate) { slaEndDate = deliveryDate; slaEndSource = "delivery"; }
    else if (bucket === "delivered" && lastStatus) { slaEndDate = lastStatus; slaEndSource = "lastStatus"; }
    var slaDays = (pickup && slaEndDate) ? (slaEndDate.getTime() - pickup.getTime()) / 86400000 : null;
    if (bucket === "delivered" && slaDays === null) missingSlaData++; // Data Quality section 10 — delivered but no usable SLA end date

    var rec = {
      awb: awb, client: client, province: province, area: area, branch: branch,
      status: status, bucket: bucket, kind: kind, finalStatus: finalStatus,
      pickup: pickup, lastStatus: lastStatus, deliveryDate: deliveryDate, slaDays: slaDays, slaEndSource: slaEndSource, cod: cod, shipCost: shipCost,
      attemptCat: attemptCat
    };

    if (province) provinceSet[province] = true;
    if (branch) branchSet[branch] = true;
    if (client) clientSet[client] = true;
    if (status) statusSet[status] = true;
    if (area) {
      areaSet[area] = true;
      if (province) {
        if (!areasByProvinceSets[province]) areasByProvinceSets[province] = {};
        areasByProvinceSets[province][area] = true;
      }
    }

    if (awbMap.hasOwnProperty(awb)) {
      dupCount++;
      var existingRec = awbMap[awb];
      // Duplicate-record capture, inline — no second pass needed: by the
      // time a duplicate is detected we already hold both the previous
      // occurrence (existingRec) and this one.
      if (duplicateRecords.length < DQ_MAX_DUPLICATE_RECORDS) {
        if (seenAwbCount[awb] === 2) duplicateRecords.push(summaryFormatDuplicateRecord(existingRec));
        if (duplicateRecords.length < DQ_MAX_DUPLICATE_RECORDS) duplicateRecords.push(summaryFormatDuplicateRecord(rec));
        else duplicateRecordsTruncated = true;
      } else {
        duplicateRecordsTruncated = true;
      }
      var et = existingRec.lastStatus ? existingRec.lastStatus.getTime() : -Infinity;
      var rt = lastStatus ? lastStatus.getTime() : -Infinity;
      if (rt >= et) awbMap[awb] = rec;
    } else {
      awbMap[awb] = rec;
    }
  }
  duplicateRecords.sort(function (a, b) { return a.awb < b.awb ? -1 : (a.awb > b.awb ? 1 : 0); });

  var areasByProvinceOut = {};
  for (var provKey in areasByProvinceSets) {
    if (areasByProvinceSets.hasOwnProperty(provKey)) areasByProvinceOut[provKey] = summaryObjKeysSorted(areasByProvinceSets[provKey]);
  }
  var facets = {
    provinces: summaryObjKeysSorted(provinceSet),
    branches: summaryObjKeysSorted(branchSet),
    clients: summaryObjKeysSorted(clientSet),
    statuses: summaryObjKeysSorted(statusSet),
    areasAll: summaryObjKeysSorted(areaSet),
    areasByProvince: areasByProvinceOut
  };

  var distinctAwbCount = Object.keys(seenAwbCount).length;
  var duplicateExtraRows = dqTotalRows - distinctAwbCount; // rows beyond the first occurrence for each repeated AWB
  var dataQuality = {
    totalRows: dqTotalRows,
    distinctAwb: distinctAwbCount,
    dupAwbCount: dupCount > 0 ? (function () { var c = 0; for (var k in seenAwbCount) { if (seenAwbCount.hasOwnProperty(k) && seenAwbCount[k] > 1) c++; } return c; })() : 0,
    invalidDates: invalidDates,
    missingBranch: missingBranch,
    missingClient: missingClient,
    missingProvince: missingProvince,
    unknownStatusCount: unknownStatusCount,
    unknownStatusList: summaryObjKeysSorted(unknownStatusSet),
    unknownStatusBreakdown: summaryUnknownStatusBreakdown_(unknownStatusSet),
    missingSlaData: missingSlaData,
    negativeCod: negativeCod,
    duplicateRecords: duplicateRecords,
    duplicateRecordsTruncated: duplicateRecordsTruncated,
    // Full reconciliation chain — every quantity is a plain count, never a
    // guess: physicalRows === fullyBlankRows + blankAwbRows + validAwbRows,
    // and validAwbRows === duplicateExtraRows + uniqueShipments.
    reconciliation: {
      physicalRows: dataRows.length,
      fullyBlankRows: fullyBlankRowCount,
      blankAwbRows: blankAwbRowCount,
      validAwbRows: dqTotalRows,
      duplicateExtraRows: duplicateExtraRows,
      uniqueShipments: distinctAwbCount
    }
  };
  var tNormalizeEnd = new Date().getTime();

  // A sheet can contain stray non-empty cells (a totals row, a leftover
  // note, formatting) that pass the hasAnyContent check above yet have zero
  // rows with a valid AWB — i.e. zero real shipments. Contract fix: this is
  // the SAME empty/noData state as a genuinely blank sheet, never a
  // half-populated "not empty" result with totalRows===0.
  if (dqTotalRows === 0) {
    return {
      success: true, sheet: sheetName, source: quarter, empty: true, noData: true,
      totalRows: dataRows.length, grandTotal: 0,
      attemptSummary: { first: 0, second: 0, other: 0, na: 0, total: 0 },
      timeSeries: { daily: [], weekly: [], monthly: [] },
      dataQuality: dataQuality,
      facets: { provinces: [], branches: [], clients: [], statuses: [], areasAll: [], areasByProvince: {} },
      colMap: colMap, generatedAt: new Date().toISOString()
    };
  }

  var tDedupBuildStart = new Date().getTime();
  var allDedupRows = [];
  for (var awbKey in awbMap) { if (awbMap.hasOwnProperty(awbKey)) allDedupRows.push(awbMap[awbKey]); }
  var grandTotal = allDedupRows.length;
  var tDedupBuildEnd = new Date().getTime();

  // ============================================================
  // PASS 2 (aggregate) — ONE loop over the deduped rows. Every aggregation
  // that used to be its own full pass (main KPIs, branch/customer/province/
  // area breakdowns, SLA per group, status/finalStatus counts, COD/ship-cost
  // totals, the attempt-distribution baseline, and all three Growth/Trend
  // granularities) is accumulated together here, per row, once.
  // ============================================================
  var tAggregateStart = new Date().getTime();

  var fromTime = dateFrom ? new Date(dateFrom + "T00:00:00").getTime() : null;
  var toTime = dateTo ? new Date(dateTo + "T23:59:59").getTime() : null;

  var topAcc = summaryNewGroupAcc();
  var topSlaDaysArr = [];
  var branchAccMap = {}, branchOrder = [];
  var customerAccMap = {}, customerOrder = [];
  var provinceAccMap = {}, provinceOrder = [];
  var areaAccMap = {}, areaOrder = [];
  var statusSummary = {}, finalStatusSummary = {};
  var totalCod = 0, totalShipCost = 0;
  var dailyMap = {}, dailyOrder = [];
  var weeklyMap = {}, weeklyOrder = [];
  var monthlyMap = {}, monthlyOrder = [];
  var attemptSummary = { first: 0, second: 0, other: 0, na: 0, total: 0 };
  var trendMapFiltered = {}; // Overview tab's 14-day mini trend — {date,count,delivered} shape

  var tz = Session.getScriptTimeZone() || "Africa/Cairo";

  // PERFORMANCE FIX (see docs/production-debug-fixes.md — Bug #5): the loop
  // below used to call Utilities.formatDate(pr.pickup, tz, "yyyy-MM-dd")
  // for EVERY row (once for dayKey, and again for cubeDayKey during a
  // persistent-build) — up to ~212,000 calls for a 106k-row month. Each
  // Utilities.* call crosses the Apps Script host bridge and costs roughly
  // sub-millisecond-to-a-millisecond on its own; multiplied by that many
  // calls this alone accounted for the bulk of the ~88s aggregatePassMs
  // measured on August.
  // The formatted string is memoized per bucket instead of recomputed per
  // row. IMPORTANT: the bucket is by UTC HOUR (3,600,000ms), not by UTC day
  // — an earlier draft of this fix bucketed by day and had a real bug: a
  // day-wide bucket in UTC time does not line up with a calendar day in
  // Africa/Cairo (UTC+2), so two different rows landing in the same UTC day
  // could legitimately format to two different Cairo dates, and whichever
  // was cached first would silently poison the other's result. A 1-hour
  // bucket cannot straddle a midnight boundary in any fixed whole-hour
  // offset timezone (Africa/Cairo has had no DST since 2015 and is a clean
  // UTC+2), so every row in the same bucket is provably on the same
  // Cairo calendar day — this was verified with a dedicated test covering
  // the exact 22:00–24:00 UTC boundary window for every day of the month.
  // A month still has well under a thousand distinct hour-buckets, so this
  // still cuts the real Utilities.formatDate call count by well over 99%.
  var dayKeyCache = {};
  function formatDayKeyCached(d) {
    var bucket = Math.floor(d.getTime() / 3600000); // UTC-hour bucket — see note above on why this (not a day bucket) is the safe choice
    var cached = dayKeyCache[bucket];
    if (cached !== undefined) return cached;
    var formatted = Utilities.formatDate(d, tz, "yyyy-MM-dd");
    dayKeyCache[bucket] = formatted;
    return formatted;
  }

  // ------------------------------------------------------------
  // FILTERABLE SUMMARY V2 — a compact, dictionary-encoded cube built ONLY
  // during a persistent-build request (isPersistentBuild), fused into this
  // SAME aggregate pass. Each record represents every shipment sharing the
  // same (province, area, branch, client, status, attemptCat, pickupDate)
  // — never a raw row, never an AWB — with pre-aggregated counts. This is
  // what lets a LATER filtered query answer instantly from the saved
  // summary instead of re-reading the raw sheet. SLA within/breach counts
  // and maxSlaDays are pre-classified here (using the SAME slaTargetDefault/
  // branchSlaTargets this snapshot was built with) because they depend on
  // each row's own slaDays value, which cannot be reconstructed later from
  // grouped totals alone.
  var cubeDict = { province: [], area: [], branch: [], client: [], status: [] };
  var cubeDictIdx = { province: {}, area: {}, branch: {}, client: {}, status: {} };
  var cubeRecordMap = {}, cubeRecordOrder = [];
  var CUBE_ATTEMPT_KEYS = ["first", "second", "other", "na"];
  function cubeDictIndex(dim, value) {
    var idxMap = cubeDictIdx[dim], arr = cubeDict[dim];
    if (idxMap.hasOwnProperty(value)) return idxMap[value];
    var idx = arr.length;
    arr.push(value);
    idxMap[value] = idx;
    return idx;
  }

  function ensureAcc(map, order, key) {
    if (!map[key]) { map[key] = summaryNewGroupAcc(); order.push(key); }
    return map[key];
  }
  function ensureTimeAcc(map, order, key) {
    if (!map[key]) { map[key] = { shipments: 0, delivered: 0, returned: 0, pending: 0 }; order.push(key); }
    return map[key];
  }
  function bumpTimeAcc(acc, bucket) {
    acc.shipments++;
    if (bucket === "delivered") acc.delivered++;
    else if (bucket === "returned") acc.returned++;
    else if (bucket === "pending") acc.pending++;
  }

  for (var pi = 0; pi < allDedupRows.length; pi++) {
    var pr = allDedupRows[pi];

    var baselineMatch = summaryRowMatchesFilters(pr, filters, "attempt", fromTime, toTime);
    if (baselineMatch) {
      attemptSummary.total++;
      attemptSummary[pr.attemptCat]++;
    }

    if (!summaryRowMatchesFilters(pr, filters, null, fromTime, toTime)) continue;

    var target = (branchSlaTargets && branchSlaTargets[pr.branch] !== undefined) ? branchSlaTargets[pr.branch] : slaTargetDefault;

    if (isPersistentBuild) {
      var cubeDayKey = pr.pickup ? formatDayKeyCached(pr.pickup) : "";
      var cubeAttemptIdx = CUBE_ATTEMPT_KEYS.indexOf(pr.attemptCat);
      if (cubeAttemptIdx < 0) cubeAttemptIdx = 3; // "na"
      var cubeKey = cubeDictIndex("province", pr.province || "غير محدد") + "\u0001" +
        cubeDictIndex("area", pr.area || "غير محدد") + "\u0001" +
        cubeDictIndex("branch", pr.branch || "غير محدد") + "\u0001" +
        cubeDictIndex("client", pr.client || "غير محدد") + "\u0001" +
        cubeDictIndex("status", pr.status || "غير محدد") + "\u0001" +
        cubeAttemptIdx + "\u0001" + cubeDayKey;
      if (!cubeRecordMap[cubeKey]) {
        var newRec = {
          p: cubeDictIdx.province[pr.province || "غير محدد"], a: cubeDictIdx.area[pr.area || "غير محدد"],
          br: cubeDictIdx.branch[pr.branch || "غير محدد"], c: cubeDictIdx.client[pr.client || "غير محدد"],
          s: cubeDictIdx.status[pr.status || "غير محدد"], at: cubeAttemptIdx, d: cubeDayKey,
          n: 0, ws: 0, sb: 0, sd: 0, dwd: 0, mx: 0, cod: 0, sc: 0
        };
        cubeRecordMap[cubeKey] = newRec;
        cubeRecordOrder.push(cubeKey);
      }
      var crec = cubeRecordMap[cubeKey];
      crec.n++;
      crec.cod += pr.cod; crec.sc += pr.shipCost;
      if (pr.bucket === "delivered" && pr.slaDays !== null) {
        crec.dwd++;
        crec.sd += pr.slaDays;
        if (pr.slaDays > crec.mx) crec.mx = pr.slaDays;
        if (pr.slaDays <= target) crec.ws++; else crec.sb++;
      }
    }

    summaryAccumulateRow(topAcc, pr, target);
    if (pr.bucket === "delivered" && pr.slaDays !== null) topSlaDaysArr.push(pr.slaDays);

    summaryAccumulateRow(ensureAcc(branchAccMap, branchOrder, pr.branch || "غير محدد"), pr, target);
    summaryAccumulateRow(ensureAcc(customerAccMap, customerOrder, pr.client || "غير محدد"), pr, target);
    summaryAccumulateRow(ensureAcc(provinceAccMap, provinceOrder, pr.province || "غير محدد"), pr, target);
    summaryAccumulateRow(ensureAcc(areaAccMap, areaOrder, pr.area || "غير محدد"), pr, target);

    var st = pr.status || "غير محدد";
    statusSummary[st] = (statusSummary[st] || 0) + 1;
    var fs = pr.finalStatus || "غير محدد";
    finalStatusSummary[fs] = (finalStatusSummary[fs] || 0) + 1;

    totalCod += pr.cod;
    totalShipCost += pr.shipCost;

    if (pr.pickup) {
      var dayKey = formatDayKeyCached(pr.pickup);
      if (!trendMapFiltered[dayKey]) trendMapFiltered[dayKey] = { date: dayKey, count: 0, delivered: 0 };
      trendMapFiltered[dayKey].count++;
      if (pr.bucket === "delivered") trendMapFiltered[dayKey].delivered++;

      bumpTimeAcc(ensureTimeAcc(dailyMap, dailyOrder, dayKey), pr.bucket);
      bumpTimeAcc(ensureTimeAcc(weeklyMap, weeklyOrder, summaryWeekKey(pr.pickup)), pr.bucket);
      bumpTimeAcc(ensureTimeAcc(monthlyMap, monthlyOrder, summaryMonthKey(pr.pickup)), pr.bucket);
    }
  }
  var tAggregateEnd = new Date().getTime();

  // ============================================================
  // FINALIZE — proportional to the number of DISTINCT groups/buckets, not
  // to row count (cheap even for a month with thousands of branches/clients).
  // ============================================================
  var tFinalizeStart = new Date().getTime();

  topSlaDaysArr.sort(function (a, b) { return a - b; });
  var topAvgDays = topSlaDaysArr.length ? (topSlaDaysArr.reduce(function (a, b) { return a + b; }, 0) / topSlaDaysArr.length) : null;
  var topMedianDays = topSlaDaysArr.length ? topSlaDaysArr[Math.floor(topSlaDaysArr.length / 2)] : null;
  var topMaxDays = topSlaDaysArr.length ? topSlaDaysArr[topSlaDaysArr.length - 1] : null;
  var topEligible = topAcc.total - topAcc.pending;
  var kpis = {
    total: topAcc.total, delivered: topAcc.delivered, returned: topAcc.returned, returnClosed: topAcc.returnClosed, returnOpen: topAcc.returnOpen, returnHold: topAcc.returnHold, rejected: topAcc.rejected,
    pending: topAcc.pending, unknown: topAcc.unknown, eligible: topEligible,
    deliveryRate: topAcc.total > 0 ? (topAcc.delivered / topAcc.total * 100) : null,
    returnRate: topEligible > 0 ? (topAcc.returned / topEligible * 100) : null,
    rejectedRate: topEligible > 0 ? (topAcc.rejected / topEligible * 100) : null,
    successRate: topAcc.total > 0 ? ((topAcc.delivered + topAcc.rejected) / topAcc.total * 100) : null,
    withinSla: topAcc.withinSla, slaBreach: topAcc.slaBreach,
    slaAchievement: topAcc.deliveredWithDate > 0 ? (topAcc.withinSla / topAcc.deliveredWithDate * 100) : null,
    avgDays: topAvgDays, medianDays: topMedianDays, maxDays: topMaxDays, deliveredWithDate: topAcc.deliveredWithDate
  };

  var branchSummary = summaryFinalizeGroupList(branchAccMap, branchOrder, 3000);
  var customerSummary = summaryFinalizeGroupList(customerAccMap, customerOrder, 3000);
  var provinceSummary = summaryFinalizeGroupList(provinceAccMap, provinceOrder, 1000);
  var areaSummary = summaryFinalizeGroupList(areaAccMap, areaOrder, 1000);

  var trend = [];
  for (var tKey in trendMapFiltered) { if (trendMapFiltered.hasOwnProperty(tKey)) trend.push(trendMapFiltered[tKey]); }
  trend.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  var timeSeries = {
    daily: summaryFinalizeTimeSeries(dailyMap, dailyOrder),
    weekly: summaryFinalizeTimeSeries(weeklyMap, weeklyOrder),
    monthly: summaryFinalizeTimeSeries(monthlyMap, monthlyOrder)
  };
  var tFinalizeEnd = new Date().getTime();

  // ============================================================
  // RESPONSE — same contract as before this hotfix, field for field.
  // ============================================================
  var tResponsePrepStart = new Date().getTime();
  var result = {
    success: true,
    sheet: sheetName,
    source: quarter,
    branchFilter: branchFilter || null, // legacy field, kept for existing Management Analysis callers
    filtersApplied: filters,
    empty: false,
    noData: false,
    totalRows: dataRows.length,
    grandTotal: grandTotal,
    generatedAt: new Date().toISOString(),
    kpis: kpis,
    attemptSummary: attemptSummary,
    dq: {
      totalRows: topAcc.total,
      distinctAwb: topAcc.total,
      dupAwbCount: dupCount,
      invalidDates: invalidDates
    },
    totalCod: totalCod,
    totalShipCost: totalShipCost,
    branchSummary: branchSummary,
    customerSummary: customerSummary,
    provinceSummary: provinceSummary,
    areaSummary: areaSummary,
    statusSummary: statusSummary,
    finalStatusSummary: finalStatusSummary,
    trend: trend,
    timeSeries: timeSeries,
    dataQuality: dataQuality,
    colMap: colMap,
    facets: facets,
    cached: false
  };
  if (isPersistentBuild) {
    result.filterCube = { version: 2, dict: cubeDict, records: cubeRecordOrder.map(function(k){
      var r = cubeRecordMap[k];
      return [r.p, r.a, r.br, r.c, r.s, r.at, r.d, r.n, r.ws, r.sb, r.sd, r.dwd, r.mx, r.cod, r.sc];
    }), buildConfig: {
      attemptT1: attemptT1, attemptT2: attemptT2,
      slaTargetDefault: slaTargetDefault, branchSlaTargets: branchSlaTargets
    } };
  }
  var tResponsePrepEnd = new Date().getTime();

  try {
    var serialized = JSON.stringify(result);
    // Chunked write — no more silent "skip caching if >100KB" (see
    // cachePutChunked above). A sane upper bound still guards against a
    // truly pathological payload consuming excessive cache quota.
    if (serialized.length < 3000000) {
      cachePutChunked(cache, cacheKey, serialized, DASHBOARD_CACHE_TTL_SECONDS);
    }
  } catch (cacheErr) {
    // Non-fatal — caching is a performance optimization, not a requirement.
  }

  var tTotalEnd = new Date().getTime();
  var debugTimings = {
    totalMs: tTotalEnd - tStart,
    openSpreadsheetMs: tOpenEnd - tOpenStart,
    locateSheetMs: tLocateEnd - tOpenEnd,
    dimensionsMs: tDimEnd - tLocateEnd,
    readMs: tReadEnd - tReadStart,
    headerMappingMs: tMapEnd - tMapStart,
    normalizePassMs: tNormalizeEnd - tNormalizeStart,
    dedupBuildMs: tDedupBuildEnd - tDedupBuildStart,
    aggregatePassMs: tAggregateEnd - tAggregateStart,
    finalizeMs: tFinalizeEnd - tFinalizeStart,
    responsePrepMs: tResponsePrepEnd - tResponsePrepStart,
    rowCounts: { rawDataRows: dataRows.length, distinctAwb: grandTotal, matchedAfterFilters: topAcc.total },
    notes: "KPI + branch/customer/province/area + SLA + Growth-Trend timeSeries + attempt-baseline are fused into ONE pass (aggregatePassMs). Data Quality counters, facets, and duplicate-record capture are fused into the normalization pass (normalizePassMs). 'Reading headers' has no separate cost — headers and data share one getRange().getValues() call (readMs)."
  };
  // ALWAYS logged (regardless of ?debug=1) so every real execution in the
  // Apps Script Executions transcript — including ones nobody thought to
  // reproduce with debug=1 — can be diagnosed after the fact.
  console.log("[TIMING] " + JSON.stringify(Object.assign({ requestId: params.__requestId || null, sheet: sheetName }, debugTimings)));

  // The JSON response only includes the `debug` field when explicitly
  // requested — keeps the normal API contract unchanged.
  if (debugMode) {
    result.debug = debugTimings;
  }

  return result;
}


// ============================================================
// 5C. ALL MONTHS — combine already-computed Compact Summaries
// ============================================================
// CRITICAL AGGREGATION RULE: every rate below (deliveryRate/returnRate/
// rejectedRate/successRate/slaPct/avgDays) is recomputed from SUMMED
// underlying counts across months — never by averaging each month's own
// percentage. See summaryMergeTopKpis/summaryMergeGroupLists.

// Top-level KPI merge — EXACT (the per-month `kpis` object carries the full
// breakdown: total/delivered/returned/rejected/pending/unknown/withinSla/
// slaBreach/deliveredWithDate), so every rate here is fully precise.
// medianDays is the one field that cannot be validly derived from monthly
// medians (median does not combine that way) — left null rather than faked;
// maxDays IS validly the max of each month's max.
function summaryMergeTopKpis(kpisList) {
  var acc = { total:0, delivered:0, returned:0, returnClosed:0, returnOpen:0, returnHold:0, rejected:0, pending:0, unknown:0, withinSla:0, slaBreach:0, deliveredWithDate:0, sumSlaDaysWeighted:0 };
  var maxDays = null, subKindsKnown = true;
  for (var i = 0; i < kpisList.length; i++) {
    var k = kpisList[i]; if (!k) continue;
    acc.total += k.total||0; acc.delivered += k.delivered||0; acc.returned += k.returned||0;
    acc.rejected += k.rejected||0; acc.pending += k.pending||0; acc.unknown += k.unknown||0;
    if (k.returnClosed === undefined) subKindsKnown = false; // a month saved before the 8-card taxonomy: its return split is unknown
    acc.returnClosed += k.returnClosed||0; acc.returnOpen += k.returnOpen||0; acc.returnHold += k.returnHold||0;
    acc.withinSla += k.withinSla||0; acc.slaBreach += k.slaBreach||0; acc.deliveredWithDate += k.deliveredWithDate||0;
    acc.sumSlaDaysWeighted += (k.avgDays||0) * (k.deliveredWithDate||0);
    if (k.maxDays !== null && k.maxDays !== undefined) maxDays = (maxDays===null) ? k.maxDays : Math.max(maxDays, k.maxDays);
  }
  var eligible = acc.total - acc.pending;
  return {
    total: acc.total, delivered: acc.delivered, returned: acc.returned, returnClosed: subKindsKnown ? acc.returnClosed : undefined, returnOpen: subKindsKnown ? acc.returnOpen : undefined, returnHold: subKindsKnown ? acc.returnHold : undefined, rejected: acc.rejected,
    pending: acc.pending, unknown: acc.unknown, eligible: eligible,
    deliveryRate: acc.total>0 ? (acc.delivered/acc.total*100) : null,
    returnRate: eligible>0 ? (acc.returned/eligible*100) : null,
    rejectedRate: eligible>0 ? (acc.rejected/eligible*100) : null,
    successRate: acc.total>0 ? ((acc.delivered+acc.rejected)/acc.total*100) : null,
    withinSla: acc.withinSla, slaBreach: acc.slaBreach,
    slaAchievement: acc.deliveredWithDate>0 ? (acc.withinSla/acc.deliveredWithDate*100) : null,
    avgDays: acc.deliveredWithDate>0 ? (acc.sumSlaDaysWeighted/acc.deliveredWithDate) : null,
    medianDays: null, // not mathematically derivable from monthly medians — documented limitation, never faked
    maxDays: maxDays,
    deliveredWithDate: acc.deliveredWithDate
  };
}

// Per-entity (branch/customer/province/area) merge across months. "eligible"
// is total - pending, exactly as in single-month results. Entities saved
// BEFORE the `pending` field was added (older snapshots) lack it; for those
// only, eligible falls back to resolved = delivered+returned+rejected, which
// overstates return/reject rate when unclassified statuses exist. Rebuilding
// the summaries ("تحديث الداش بورد") stores `pending` and removes the gap. deliveredWithDate
// (needed for exact avgDays/slaPct weighting) IS reconstructed exactly as
// withinSla+slaBreach — no approximation there.
function summaryMergeGroupLists(listOfArrays, topN) {
  var accMap = {};
  var order = [];
  for (var a = 0; a < listOfArrays.length; a++) {
    var arr = listOfArrays[a] || [];
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!accMap[e.name]) { accMap[e.name] = { shipments:0, delivered:0, returned:0, rejected:0, pending:0, pendingKnown:true, withinSla:0, slaBreach:0, sumSlaDaysWeighted:0, dwdTotal:0 }; order.push(e.name); }
      var acc = accMap[e.name];
      acc.shipments += e.shipments||0; acc.delivered += e.delivered||0; acc.returned += e.returned||0; acc.rejected += e.rejected||0;
      if (typeof e.pending === "number") acc.pending += e.pending; else acc.pendingKnown = false;
      acc.withinSla += e.withinSla||0; acc.slaBreach += e.slaBreach||0;
      var dwd = (e.withinSla||0) + (e.slaBreach||0);
      acc.sumSlaDaysWeighted += (e.avgDays||0) * dwd;
      acc.dwdTotal += dwd;
    }
  }
  var out = [];
  for (var k = 0; k < order.length; k++) {
    var name = order[k];
    var acc = accMap[name];
    var resolved = acc.pendingKnown ? (acc.shipments - acc.pending) : (acc.delivered + acc.returned + acc.rejected);
    out.push({
      name: name, shipments: acc.shipments, delivered: acc.delivered,
      deliveryRate: acc.shipments>0 ? (acc.delivered/acc.shipments*100) : null,
      returned: acc.returned, returnRate: resolved>0 ? (acc.returned/resolved*100) : null,
      rejected: acc.rejected, rejectedRate: resolved>0 ? (acc.rejected/resolved*100) : null,
      successRate: acc.shipments>0 ? ((acc.delivered+acc.rejected)/acc.shipments*100) : null,
      avgDays: acc.dwdTotal>0 ? (acc.sumSlaDaysWeighted/acc.dwdTotal) : null,
      withinSla: acc.withinSla, slaBreach: acc.slaBreach,
      slaPct: (acc.withinSla+acc.slaBreach)>0 ? (acc.withinSla/(acc.withinSla+acc.slaBreach)*100) : null
    });
  }
  out.sort(function (a, b) { return b.shipments - a.shipments; });
  if (topN && out.length > topN) out = out.slice(0, topN);
  return out;
}

function summaryMergeCountMaps(list) {
  var out = {};
  for (var i = 0; i < list.length; i++) {
    var m = list[i]; if (!m) continue;
    for (var k in m) { if (m.hasOwnProperty(k)) out[k] = (out[k]||0) + (m[k]||0); }
  }
  return out;
}

function summaryMergeTimeSeriesList(list) {
  // Daily/weekly/monthly labels (yyyy-MM-dd / yyyy-Www / yyyy-MM) are
  // globally unique across the whole year regardless of which month
  // produced them, so concatenating every month's entries (no de-dup
  // needed) and sorting is exact — no double-counting.
  var all = [];
  for (var i = 0; i < list.length; i++) all = all.concat(list[i]||[]);
  all.sort(function (a, b) { return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0); });
  return all;
}
function summaryMergeTrendList(list) {
  var all = [];
  for (var i = 0; i < list.length; i++) all = all.concat(list[i]||[]);
  all.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return all;
}
function summaryMergeDataQuality(dqList) {
  var totalRows=0, distinctAwb=0, dupAwbCount=0, invalidDates=0, missingBranch=0, missingClient=0, missingProvince=0, unknownStatusCount=0, negativeCod=0, missingSlaData=0;
  var unknownStatusSet = {};
  var unknownStatusCounts = {};
  var allDupRecords = [];
  var truncated = false;
  var DQ_ALL_MONTHS_CAP = 1000;
  var recon = { physicalRows:0, fullyBlankRows:0, blankAwbRows:0, validAwbRows:0, duplicateExtraRows:0, uniqueShipments:0 };
  for (var i = 0; i < dqList.length; i++) {
    var dq = dqList[i]; if (!dq) continue;
    totalRows += dq.totalRows||0; distinctAwb += dq.distinctAwb||0; dupAwbCount += dq.dupAwbCount||0;
    invalidDates += dq.invalidDates||0; missingBranch += dq.missingBranch||0; missingClient += dq.missingClient||0;
    missingProvince += dq.missingProvince||0; unknownStatusCount += dq.unknownStatusCount||0; negativeCod += dq.negativeCod||0;
    missingSlaData += dq.missingSlaData||0;
    var usl = dq.unknownStatusList || [];
    for (var u = 0; u < usl.length; u++) unknownStatusSet[usl[u]] = true;
    var usb = dq.unknownStatusBreakdown || [];
    for (var ub = 0; ub < usb.length; ub++) {
      unknownStatusCounts[usb[ub].status] = (unknownStatusCounts[usb[ub].status]||0) + (usb[ub].count||0);
    }
    if (dq.duplicateRecordsTruncated) truncated = true;
    var recs = dq.duplicateRecords || [];
    for (var r = 0; r < recs.length; r++) {
      if (allDupRecords.length < DQ_ALL_MONTHS_CAP) allDupRecords.push(recs[r]);
      else { truncated = true; break; }
    }
    var rc = dq.reconciliation;
    if (rc) {
      recon.physicalRows += rc.physicalRows||0; recon.fullyBlankRows += rc.fullyBlankRows||0;
      recon.blankAwbRows += rc.blankAwbRows||0; recon.validAwbRows += rc.validAwbRows||0;
      recon.duplicateExtraRows += rc.duplicateExtraRows||0; recon.uniqueShipments += rc.uniqueShipments||0;
    }
  }
  allDupRecords.sort(function (a, b) { return a.awb < b.awb ? -1 : (a.awb > b.awb ? 1 : 0); });
  return {
    totalRows: totalRows, distinctAwb: distinctAwb, dupAwbCount: dupAwbCount, invalidDates: invalidDates,
    missingBranch: missingBranch, missingClient: missingClient, missingProvince: missingProvince,
    unknownStatusCount: unknownStatusCount, unknownStatusList: summaryObjKeysSorted(unknownStatusSet),
    unknownStatusBreakdown: summaryUnknownStatusBreakdown_(unknownStatusCounts),
    missingSlaData: missingSlaData,
    negativeCod: negativeCod, duplicateRecords: allDupRecords, duplicateRecordsTruncated: truncated,
    reconciliation: recon
  };
}
function summaryMergeFacets(facetsList) {
  var provinceSet={}, branchSet={}, clientSet={}, statusSet={}, areaSet={};
  var areasByProvinceSets = {};
  for (var i = 0; i < facetsList.length; i++) {
    var f = facetsList[i]; if (!f) continue;
    (f.provinces||[]).forEach(function(v){ provinceSet[v]=true; });
    (f.branches||[]).forEach(function(v){ branchSet[v]=true; });
    (f.clients||[]).forEach(function(v){ clientSet[v]=true; });
    (f.statuses||[]).forEach(function(v){ statusSet[v]=true; });
    (f.areasAll||[]).forEach(function(v){ areaSet[v]=true; });
    var abp = f.areasByProvince || {};
    for (var prov in abp) {
      if (!abp.hasOwnProperty(prov)) continue;
      if (!areasByProvinceSets[prov]) areasByProvinceSets[prov] = {};
      (abp[prov]||[]).forEach(function(a){ areasByProvinceSets[prov][a]=true; });
    }
  }
  var areasByProvinceOut = {};
  for (var p in areasByProvinceSets) { if (areasByProvinceSets.hasOwnProperty(p)) areasByProvinceOut[p] = summaryObjKeysSorted(areasByProvinceSets[p]); }
  return {
    provinces: summaryObjKeysSorted(provinceSet), branches: summaryObjKeysSorted(branchSet),
    clients: summaryObjKeysSorted(clientSet), statuses: summaryObjKeysSorted(statusSet),
    areasAll: summaryObjKeysSorted(areaSet), areasByProvince: areasByProvinceOut
  };
}

function getAllMonthsDashboardSummary(params) {
  var t0 = new Date().getTime();
  var debugMode = !!(params && (params.debug === "1" || params.debug === "true"));
  var requestedFilters = summaryParseFilters(params);
  var hasServerFilters = Object.keys(requestedFilters).some(function (k) {
    return Array.isArray(requestedFilters[k]) && requestedFilters[k].length > 0;
  }) || !!(params && (params.dateFrom || params.dateTo || summaryNormText(params.branch)));

  var attemptT1 = (params && params.attemptT1 !== undefined && params.attemptT1 !== "") ? parseFloat(params.attemptT1) : 1;
  var attemptT2 = (params && params.attemptT2 !== undefined && params.attemptT2 !== "") ? parseFloat(params.attemptT2) : 2;
  if (isNaN(attemptT1)) attemptT1 = 1;
  if (isNaN(attemptT2)) attemptT2 = 2;
  var slaTargetDefault = (params && params.slaTarget !== undefined && params.slaTarget !== "") ? parseFloat(params.slaTarget) : SUMMARY_DEFAULT_SLA_DAYS;
  if (isNaN(slaTargetDefault)) slaTargetDefault = SUMMARY_DEFAULT_SLA_DAYS;
  var branchSlaTargets = {};
  if (params && params.branchSlaTargets) {
    try { var pt = JSON.parse(params.branchSlaTargets); if (pt && typeof pt === "object") branchSlaTargets = pt; } catch (eT) {}
  }
  var dateFrom = (params && params.dateFrom) ? params.dateFrom : "";
  var dateTo = (params && params.dateTo) ? params.dateTo : "";
  var forceRefresh = debugMode || (params && (params.refresh === "1" || params.refresh === "true"));

  // ROOT CAUSE FIX — architectural, not a timeout increase:
  // Previously, ANY unfiltered All-Months request (forced or not — force
  // only controlled whether the CacheService result-cache was bypassed)
  // would live-aggregate every month whose snapshot was missing or
  // incompatible, right there in the same HTTP request, budgeted up to
  // ALL_MONTHS_TIME_BUDGET_MS = 260 seconds. Since a real per-branch SLA
  // override makes every existing snapshot "incompatible" until rebuilt,
  // this meant EVERY normal dashboard open/refresh (not just the first)
  // could silently turn into a multi-minute live read of every month's raw
  // sheet — exactly the "Dashboard takes forever to open" symptom, and no
  // client-side timeout number can fix a problem that originates in what
  // the backend itself unconditionally attempts.
  // Now: only an EXPLICIT forced refresh (refresh=1 — e.g. the "تحديث الآن"
  // button, or debug mode) may pay for that live aggregation. A normal/
  // passive request (the default for every page open, every background
  // auto-refresh, every plain month switch) stays fast no matter what: it
  // uses whatever snapshot each month already has — even if stale/
  // incompatible — and explicitly flags which months are stale, instead of
  // ever reading a raw sheet inline. This never invents data: a stale
  // snapshot is real, previously-computed data, just possibly built under
  // an older SLA configuration.
  var allowHeavyLiveFallback = forceRefresh;
  var staleSlaMonths = []; // months shown from a snapshot that predates the CURRENT SLA/attempt config — real data, flagged as needing a rebuild

  // Cache key mirrors the single-month scheme exactly (same helper, same
  // "every calculation-affecting input" rule) — sheet slot is the sentinel.
  var cacheKey = "dash_v3_" + ALL_MONTHS_SENTINEL + "_g" + getSnapshotGenerationStamp_() + "_p_" + summaryHashKey(
    JSON.stringify(requestedFilters) + "|" + dateFrom + "|" + dateTo + "|" +
    attemptT1 + "|" + attemptT2 + "|" + slaTargetDefault + "|" + JSON.stringify(branchSlaTargets)
  );
  var cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    var cached = cacheGetChunked(cache, cacheKey);
    if (cached) {
      var cachedObj = JSON.parse(cached);
      cachedObj.cached = true;
      console.log("[CACHE HIT]" + (params.__requestId ? (" " + JSON.stringify({ requestId: params.__requestId, sheet: ALL_MONTHS_SENTINEL })) : ""));
      return cachedObj;
    }
  }

  var includedMonths = [];
  var emptyMonths = [];
  var missingSnapshotMonths = []; // months genuinely excluded: no snapshot AND live fallback also failed/was skipped
  var skippedMonths = []; // months genuinely excluded: time budget reached or an error occurred during live fallback
  var perMonthSummaries = [];
  var monthSources = {}; // month -> 'snapshot' | 'live-fallback-missing-snapshot' | 'live-fallback-incompatible' | 'live-filtered' | 'stale-snapshot-sla-mismatch' | 'filtered-cube'
  var liveFallbackTotalMs = 0; // timing diagnostic: total time actually spent in the expensive raw-sheet live-fallback path this request
  var filteredFallbackBlockedMonths = []; // FILTERED PATH months with no compatible cube, excluded because this was a normal/passive request (not an explicit refresh=1)

  // Shared by BOTH the "missing snapshot" and "incompatible snapshot" cases
  // (Rule 2 — unify the logic): never exclude a month just because its
  // snapshot isn't usable — always attempt the exact same live aggregation
  // path a single-month request already uses. Only time budget exhaustion
  // or a genuine live-aggregation failure lands the month in
  // skippedMonths/missingSnapshotMonths; a successful live result is
  // included in the total exactly like a snapshot would have been.
  function tryLiveFallbackForMonth_(month, reason) {
    var elapsedNow = new Date().getTime() - t0;
    if (elapsedNow > ALL_MONTHS_TIME_BUDGET_MS) {
      console.log("[ALL MONTHS LIVE FALLBACK SKIPPED — TIME BUDGET] " + JSON.stringify({ month: month, reason: reason, elapsedMs: elapsedNow }));
      return { ok: false, dueToBudget: true };
    }
    var fbStart = new Date().getTime();
    var monthParamsFb = {};
    for (var pkFb in params) { if (params.hasOwnProperty(pkFb)) monthParamsFb[pkFb] = params[pkFb]; }
    monthParamsFb.sheet = month;
    var monthSummaryFb;
    try { monthSummaryFb = getMonthDashboardSummary(month, monthParamsFb); }
    catch (eFb) {
      liveFallbackTotalMs += (new Date().getTime() - fbStart);
      console.log("[ALL MONTHS LIVE FALLBACK ERROR] " + JSON.stringify({ month: month, reason: reason, error: String(eFb) }));
      return { ok: false, dueToBudget: false };
    }
    liveFallbackTotalMs += (new Date().getTime() - fbStart);
    if (!monthSummaryFb || monthSummaryFb.success === false) {
      console.log("[ALL MONTHS LIVE FALLBACK FAILED] " + JSON.stringify({ month: month, reason: reason, error: monthSummaryFb && monthSummaryFb.error }));
      return { ok: false, dueToBudget: false };
    }
    if (monthSummaryFb.empty || monthSummaryFb.noData) {
      return { ok: true, empty: true };
    }
    console.log("[ALL MONTHS PER-MONTH] " + JSON.stringify({
      month: month, source: "live-fallback-" + reason, rowCount: monthSummaryFb.dq ? monthSummaryFb.dq.totalRows : null,
      total: monthSummaryFb.kpis ? monthSummaryFb.kpis.total : null, delivered: monthSummaryFb.kpis ? monthSummaryFb.kpis.delivered : null,
      returned: monthSummaryFb.kpis ? monthSummaryFb.kpis.returned : null, rejected: monthSummaryFb.kpis ? monthSummaryFb.kpis.rejected : null,
      pending: monthSummaryFb.kpis ? monthSummaryFb.kpis.pending : null, unknown: monthSummaryFb.kpis ? monthSummaryFb.kpis.unknown : null
    }));
    return { ok: true, empty: false, summary: monthSummaryFb };
  }

  for (var i = 0; i < MONTH_ORDER.length; i++) {
    var month = MONTH_ORDER[i];

    if (!hasServerFilters) {
      // FAST PATH — but "no dimension filter" does NOT mean "any snapshot is
      // safe": attemptT1/attemptT2/slaTargetDefault/branchSlaTargets affect
      // attemptCat/withinSla/slaBreach/attemptSummary independently of any
      // dimension filter, and those are frozen into the snapshot at build
      // time. Each month's OWN snapshot buildConfig is checked against the
      // CURRENT request before it is trusted — never assumed compatible
      // just because zero UI filters are active.
      var snap = getSavedMonthSummary_(month);

      if (snap && (snap.empty || snap.noData)) { emptyMonths.push(month); continue; }

      if (snap) {
        var snapBc = snap.filterCube && snap.filterCube.buildConfig;
        var snapCompatible = snapBc &&
          Number(snapBc.attemptT1) === Number(attemptT1) &&
          Number(snapBc.attemptT2) === Number(attemptT2) &&
          Number(snapBc.slaTargetDefault) === Number(slaTargetDefault) &&
          summaryBranchTargetsEqual_(snapBc.branchSlaTargets, branchSlaTargets);
        // A snapshot with no buildConfig at all predates this check — only
        // treated as compatible when the request itself uses the plain
        // defaults (matches the same leniency getMonthDashboardSummary
        // applies to its own unfiltered-snapshot path); any non-default
        // request against such a snapshot still falls through to live
        // fallback below.
        var legacyDefaultsRequested = !snapBc && Number(attemptT1) === 1 && Number(attemptT2) === 2 &&
          Number(slaTargetDefault) === SUMMARY_DEFAULT_SLA_DAYS && summaryBranchTargetsEqual_({}, branchSlaTargets);

        if (snapCompatible || legacyDefaultsRequested) {
          perMonthSummaries.push(snap);
          includedMonths.push(month);
          monthSources[month] = "snapshot";
          console.log("[ALL MONTHS PER-MONTH] " + JSON.stringify({
            month: month, source: "snapshot", rowCount: snap.dataQuality ? snap.dataQuality.totalRows : null,
            total: snap.kpis ? snap.kpis.total : null, delivered: snap.kpis ? snap.kpis.delivered : null,
            returned: snap.kpis ? snap.kpis.returned : null, rejected: snap.kpis ? snap.kpis.rejected : null,
            pending: snap.kpis ? snap.kpis.pending : null, unknown: snap.kpis ? snap.kpis.unknown : null
          }));
          continue;
        }
        // Incompatible: never silently use this snapshot's frozen
        // attempt/SLA classification as if it were current — but per the
        // architectural fix above, a normal/passive request still uses it
        // AS-IS (real, previously-computed data) rather than paying for a
        // live read, and flags it via staleSlaMonths so the frontend can
        // show a clear "needs rebuild" notice instead of silently serving
        // outdated numbers.
        console.log("[ALL MONTHS SNAPSHOT INCOMPATIBLE] " + JSON.stringify({ month: month, snapshotConfig: snapBc || null, requested: { attemptT1: attemptT1, attemptT2: attemptT2, slaTargetDefault: slaTargetDefault, branchSlaTargets: branchSlaTargets } }));
        if (!allowHeavyLiveFallback) {
          perMonthSummaries.push(snap);
          includedMonths.push(month);
          monthSources[month] = "stale-snapshot-sla-mismatch";
          staleSlaMonths.push(month);
          continue;
        }
      }

      // Reached for EITHER "no snapshot at all" OR "incompatible snapshot,
      // and this request explicitly opted into live fallback via refresh=1".
      // A normal/passive request with NO snapshot at all simply excludes the
      // month (missingSnapshotMonths) rather than reading its raw sheet —
      // the same "always fast, flag what's missing" principle as above.
      if (!snap && !allowHeavyLiveFallback) {
        missingSnapshotMonths.push(month);
        continue;
      }
      // Rule 1/Rule 2: always attempt live aggregation before excluding the
      // month — but ONLY reached here now when the request explicitly
      // allowed it (allowHeavyLiveFallback). Only a genuine failure (or time
      // budget) excludes it.
      var fbReason = snap ? "incompatible" : "missing-snapshot";
      var fb = tryLiveFallbackForMonth_(month, fbReason);
      if (!fb.ok) {
        if (fbReason === "missing-snapshot") missingSnapshotMonths.push(month);
        else skippedMonths.push(month);
        continue;
      }
      if (fb.empty) { emptyMonths.push(month); continue; }
      perMonthSummaries.push(fb.summary);
      includedMonths.push(month);
      monthSources[month] = "live-fallback-" + fbReason;
    } else {
      // FILTERED PATH — same "fast path first, gate the heavy path" rule as
      // the unfiltered branch above. A compatible filter cube (built into
      // every snapshot) answers instantly with NO raw-sheet read at all —
      // that is always attempted first here, exactly like
      // getMonthDashboardSummary does internally for a single-month filtered
      // request. Only when no compatible cube exists (missing snapshot, or
      // its cube predates the current SLA/attempt settings — the identical
      // situation the unfiltered path calls "stale/incompatible") does this
      // ever need a genuine raw-sheet read — and per the SAME rule as the
      // unfiltered path, that heavy read for a given month is only allowed
      // when this request explicitly opted in via refresh=1
      // (allowHeavyLiveFallback). Otherwise applying any server filter
      // while on All Months could silently read all 12 months' raw sheets,
      // which is exactly the scenario this fix closes. Bounded by the same
      // wall-clock budget as before either way.
      var elapsed = new Date().getTime() - t0;
      if (elapsed > ALL_MONTHS_TIME_BUDGET_MS) { skippedMonths.push(month); continue; }

      var cubeResultAM = getMonthDashboardSummaryFromCube_(month, requestedFilters, dateFrom, dateTo, attemptT1, attemptT2, slaTargetDefault, branchSlaTargets);
      if (cubeResultAM) {
        perMonthSummaries.push(cubeResultAM);
        includedMonths.push(month);
        monthSources[month] = "filtered-cube";
        console.log("[ALL MONTHS PER-MONTH] " + JSON.stringify({
          month: month, source: "filtered-cube", rowCount: cubeResultAM.dq ? cubeResultAM.dq.totalRows : null,
          total: cubeResultAM.kpis ? cubeResultAM.kpis.total : null, delivered: cubeResultAM.kpis ? cubeResultAM.kpis.delivered : null,
          returned: cubeResultAM.kpis ? cubeResultAM.kpis.returned : null, rejected: cubeResultAM.kpis ? cubeResultAM.kpis.rejected : null,
          pending: cubeResultAM.kpis ? cubeResultAM.kpis.pending : null, unknown: cubeResultAM.kpis ? cubeResultAM.kpis.unknown : null,
          fromCube: true
        }));
        continue;
      }

      if (!allowHeavyLiveFallback) {
        // No compatible cube for this month, and this is a normal/passive
        // filtered request — never silently pay for a raw-sheet read here.
        // Excluded and explicitly flagged (never presented as if the total
        // were complete) so the frontend can show a clear, honest message
        // instead of either freezing the request or inventing a number.
        filteredFallbackBlockedMonths.push(month);
        console.log("[ALL MONTHS FILTERED — HEAVY FALLBACK BLOCKED]" + JSON.stringify({ month: month, reason: "no-compatible-cube-and-not-forced" }));
        continue;
      }

      var monthParams = {};
      for (var pk in params) { if (params.hasOwnProperty(pk)) monthParams[pk] = params[pk]; }
      monthParams.sheet = month;
      var monthSummary;
      try { monthSummary = getMonthDashboardSummary(month, monthParams); }
      catch (eMonth) { skippedMonths.push(month); continue; }
      if (!monthSummary || monthSummary.success === false) { skippedMonths.push(month); continue; }
      if (monthSummary.empty || monthSummary.noData) { emptyMonths.push(month); continue; }
      perMonthSummaries.push(monthSummary);
      includedMonths.push(month);
      monthSources[month] = "live-filtered";
      console.log("[ALL MONTHS PER-MONTH] " + JSON.stringify({
        month: month, source: "live-filtered", rowCount: monthSummary.dq ? monthSummary.dq.totalRows : null,
        total: monthSummary.kpis ? monthSummary.kpis.total : null, delivered: monthSummary.kpis ? monthSummary.kpis.delivered : null,
        returned: monthSummary.kpis ? monthSummary.kpis.returned : null, rejected: monthSummary.kpis ? monthSummary.kpis.rejected : null,
        pending: monthSummary.kpis ? monthSummary.kpis.pending : null, unknown: monthSummary.kpis ? monthSummary.kpis.unknown : null,
        fromCube: !!monthSummary.filteredFromCube
      }));
    }
  }

  if (!includedMonths.length) {
    return {
      success: true, sheet: ALL_MONTHS_SENTINEL, source: "ALL", empty: true, noData: true,
      totalRows: 0, grandTotal: 0,
      attemptSummary: { first:0, second:0, other:0, na:0, total:0 },
      timeSeries: { daily:[], weekly:[], monthly:[] },
      dataQuality: { totalRows:0, distinctAwb:0, dupAwbCount:0, invalidDates:0, missingBranch:0, missingClient:0, missingProvince:0, unknownStatusCount:0, unknownStatusList:[], unknownStatusBreakdown:[], missingSlaData:0, negativeCod:0, duplicateRecords:[], duplicateRecordsTruncated:false },
      facets: { provinces:[], branches:[], clients:[], statuses:[], areasAll:[], areasByProvince:{} },
      colMap: {}, allMonths: true, includedMonths: [], emptyMonths: emptyMonths,
      missingSnapshotMonths: missingSnapshotMonths, skippedMonths: skippedMonths,
      filteredFallbackBlockedMonths: filteredFallbackBlockedMonths,
      partial: !!(skippedMonths.length || missingSnapshotMonths.length || filteredFallbackBlockedMonths.length),
      staleSlaMonths: staleSlaMonths, slaConfigStale: staleSlaMonths.length > 0,
      monthSources: monthSources,
      generatedAt: new Date().toISOString()
    };
  }

  var kpis = summaryMergeTopKpis(perMonthSummaries.map(function (s) { return s.kpis; }));
  var branchSummary = summaryMergeGroupLists(perMonthSummaries.map(function (s) { return s.branchSummary||[]; }), 3000);
  var customerSummary = summaryMergeGroupLists(perMonthSummaries.map(function (s) { return s.customerSummary||[]; }), 3000);
  var provinceSummary = summaryMergeGroupLists(perMonthSummaries.map(function (s) { return s.provinceSummary||[]; }), 1000);
  var areaSummary = summaryMergeGroupLists(perMonthSummaries.map(function (s) { return s.areaSummary||[]; }), 1000);
  var statusSummary = summaryMergeCountMaps(perMonthSummaries.map(function (s) { return s.statusSummary||{}; }));
  var finalStatusSummary = summaryMergeCountMaps(perMonthSummaries.map(function (s) { return s.finalStatusSummary||{}; }));
  var attemptAcc = { first:0, second:0, other:0, na:0, total:0 };
  for (var am = 0; am < perMonthSummaries.length; am++) {
    var a = perMonthSummaries[am].attemptSummary || {};
    attemptAcc.first += a.first||0; attemptAcc.second += a.second||0; attemptAcc.other += a.other||0;
    attemptAcc.na += a.na||0; attemptAcc.total += a.total||0;
  }
  var timeSeries = {
    daily: summaryMergeTimeSeriesList(perMonthSummaries.map(function (s) { return (s.timeSeries&&s.timeSeries.daily)||[]; })),
    weekly: summaryMergeTimeSeriesList(perMonthSummaries.map(function (s) { return (s.timeSeries&&s.timeSeries.weekly)||[]; })),
    monthly: summaryMergeTimeSeriesList(perMonthSummaries.map(function (s) { return (s.timeSeries&&s.timeSeries.monthly)||[]; }))
  };
  var trend = summaryMergeTrendList(perMonthSummaries.map(function (s) { return s.trend||[]; }));
  var dataQuality = summaryMergeDataQuality(perMonthSummaries.map(function (s) { return s.dataQuality; }));
  var facets = summaryMergeFacets(perMonthSummaries.map(function (s) { return s.facets; }));
  var grandTotal = 0, totalCod = 0, totalShipCost = 0, totalRowsSum = 0;
  var colMap = {};
  for (var gm = 0; gm < perMonthSummaries.length; gm++) {
    var s = perMonthSummaries[gm];
    grandTotal += s.grandTotal||0; totalCod += s.totalCod||0; totalShipCost += s.totalShipCost||0; totalRowsSum += s.totalRows||0;
    if (!Object.keys(colMap).length && s.colMap) colMap = s.colMap;
  }

  var result = {
    success: true, sheet: ALL_MONTHS_SENTINEL, source: "ALL",
    empty: false, noData: false,
    totalRows: totalRowsSum, grandTotal: grandTotal,
    generatedAt: new Date().toISOString(),
    kpis: kpis, attemptSummary: attemptAcc,
    dq: { totalRows: kpis.total, distinctAwb: kpis.total, dupAwbCount: dataQuality.dupAwbCount, invalidDates: dataQuality.invalidDates },
    totalCod: totalCod, totalShipCost: totalShipCost,
    branchSummary: branchSummary, customerSummary: customerSummary,
    provinceSummary: provinceSummary, areaSummary: areaSummary,
    statusSummary: statusSummary, finalStatusSummary: finalStatusSummary,
    trend: trend, timeSeries: timeSeries, dataQuality: dataQuality, colMap: colMap, facets: facets,
    allMonths: true,
    includedMonths: includedMonths, emptyMonths: emptyMonths,
    missingSnapshotMonths: missingSnapshotMonths, skippedMonths: skippedMonths,
    filteredFallbackBlockedMonths: filteredFallbackBlockedMonths,
    partial: !!(skippedMonths.length || missingSnapshotMonths.length || filteredFallbackBlockedMonths.length),
    // Batch 1 architectural fix: which months (if any) are shown from a
    // snapshot that predates the CURRENT SLA/attempt configuration. Real,
    // previously-computed data — never invented — but the frontend must
    // show a clear "needs rebuild" notice rather than presenting it as
    // fully current. Empty unless a normal/passive request found an
    // incompatible snapshot (allowHeavyLiveFallback === false case).
    staleSlaMonths: staleSlaMonths, slaConfigStale: staleSlaMonths.length > 0,
    allowedHeavyLiveFallback: allowHeavyLiveFallback,
    monthSources: monthSources,
    cached: false
  };

  try {
    var serialized = JSON.stringify(result);
    if (serialized.length < 3000000) cachePutChunked(cache, cacheKey, serialized, DASHBOARD_CACHE_TTL_SECONDS);
  } catch (cacheErr) { /* non-fatal */ }

  var tTotal = new Date().getTime() - t0;
  // Per-phase timing diagnostics (explicitly requested): snapshotMs covers
  // months served from ANY snapshot (fresh or stale) plus fast exclusions —
  // essentially free, no raw-sheet reads. liveFallbackMs isolates time spent
  // ONLY inside tryLiveFallbackForMonth_ (the expensive raw-sheet path),
  // which should be 0 for every normal/passive request after this fix, and
  // only non-zero for an explicit forced refresh.
  console.log("[TIMING] " + JSON.stringify({
    requestId: params.__requestId || null, sheet: ALL_MONTHS_SENTINEL, totalMs: tTotal,
    includedMonths: includedMonths.length, missingSnapshotMonths: missingSnapshotMonths.length,
    skippedMonths: skippedMonths.length, staleSlaMonths: staleSlaMonths.length,
    filteredFallbackBlockedMonths: filteredFallbackBlockedMonths.length,
    allowHeavyLiveFallback: allowHeavyLiveFallback, liveFallbackMs: liveFallbackTotalMs,
    filtered: hasServerFilters
  }));
  if (debugMode) {
    result.debug = {
      totalMs: tTotal, includedMonths: includedMonths, missingSnapshotMonths: missingSnapshotMonths,
      skippedMonths: skippedMonths, staleSlaMonths: staleSlaMonths, filteredFallbackBlockedMonths: filteredFallbackBlockedMonths,
      allowHeavyLiveFallback: allowHeavyLiveFallback,
      liveFallbackMs: liveFallbackTotalMs, filtered: hasServerFilters
    };
  }

  return result;
}


// ============================================================
// 5D. SHIPMENT AGE REPORT — التقرير الإداري والرقابي لعمر الشحنة
//
// Stand-alone aggregation (does NOT touch snapshots / filter cube / SLA
// settings). Population = shipments whose Pickup Date falls inside
// [dateFrom, dateTo], de-duplicated by AWB (latest Last-Status wins, same
// rule as the main dashboard).
//
// Age (calendar days, date part only — time of day ignored):
//   - closed shipments (delivered / closed return): Last Status Date - Pickup Date
//   - open shipments   (in progress / open return): asOf date        - Pickup Date
// Two standards per geographic group: market (delivery only) and company
// (delivery / return). "Within" means age <= standard.
//
// Return classification uses the Status column only:
//   same taxonomy as the dashboard cards (summaryClassifyKind): closed return = «مرتجعات» / «مغلق»;
//   open return = «مفتوح» (and on-hold «معلق» returns, aged like open ones); rejection comes from the final-status column
// Rejected ("رفض الاستلام ...") and unrecognised statuses are reported in a
// separate "other" bucket so totals always reconcile and nothing is hidden.
// ============================================================

var AGE_REPORT_GROUPS = [
  { key: "cairo", name: "القاهرة والإسكندرية", marketDays: 2, companyDeliveryDays: 15, companyReturnDays: 5,
    branches: ["مدينة نصر", "المعادي", "حدائق القبة", "المؤسسة", "العجوزة", "الهرم", "الإسكندرية", "أكتوبر", "الشروق", "رئيسي"] },
  { key: "delta", name: "الدلتا والقنال", marketDays: 3, companyDeliveryDays: 20, companyReturnDays: 6,
    branches: ["الإسماعيلية", "المنوفية", "القليوبية", "كفر الشيخ", "المنصورة", "الشرقية", "البحيرة", "طنطا"] },
  { key: "upper", name: "الصعيد", marketDays: 3, companyDeliveryDays: 20, companyReturnDays: 6,
    branches: ["الفيوم", "الصعيد"] }
];
var AGE_REPORT_MAX_MONTHS = 4;
var AGE_REPORT_MAX_OPEN_LIST = 3000;
var AGE_REPORT_CACHE_TTL_SECONDS = 600;
var AGE_REPORT_TIME_BUDGET_MS = 240000;

function ageNormBranch_(name) {
  return summaryNormalizeArabicForMatch_(summaryNormText(name))
    .replace(/^فرع\s+/, "")
    .replace(/\s+/g, "");
}
function ageDayNum_(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}
function ageDayNumFromIso_(s) { // "YYYY-MM-DD" -> same scale as ageDayNum_
  var p = String(s).split("-");
  return Math.floor(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
}
function ageIsoFromDayNum_(n) {
  var d = new Date(n * 86400000);
  var m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return d.getUTCFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
}
function ageIsoDate_(d) {
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
}

// kind: delivered | returnClosed | returnOpen | inProgress | other
function ageClassify_(status) {
  // `status` is the EFFECTIVE status (rejection already carried from the final-status column — see summaryEffectiveStatus_).
  // On-hold returns are aged like open returns (the shipment is not back with the sender yet).
  var kind = summaryClassifyKind(status);
  if (kind === "delivered") return "delivered";
  if (kind === "inProgress") return "inProgress";
  if (kind === "returnClosed") return "returnClosed";
  if (kind === "returnOpen" || kind === "returnHold") return "returnOpen";
  return "other"; // rejected / unknown — reported separately, never judged against a standard
}

function ageNewAcc_() { return { count: 0, withinMarket: 0, withinCompany: 0, over: 0, sumAge: 0, ageN: 0, noAge: 0 }; }
function ageFinalizeAcc_(a) {
  return {
    count: a.count, withinMarket: a.withinMarket, withinCompany: a.withinCompany, over: a.over, noAge: a.noAge,
    avgAge: a.ageN > 0 ? a.sumAge / a.ageN : null,
    marketPct: a.count > 0 ? a.withinMarket / a.count * 100 : null,
    companyPct: a.count > 0 ? a.withinCompany / a.count * 100 : null,
    overPct: a.count > 0 ? a.over / a.count * 100 : null
  };
}
function ageAddToAcc_(a, kind, age, std) {
  a.count++;
  if (age === null) { a.noAge++; return; }
  a.sumAge += age; a.ageN++;
  if (std.delivery < 0) return; // unassigned branch: age statistics only, never judged against a standard
  if (kind === "delivered" && age <= std.market) a.withinMarket++;
  var limit = kind === "delivered" || kind === "inProgress" ? std.delivery : std.returns;
  if (age <= limit) a.withinCompany++; else a.over++;
}
function ageNewKindAccs_() {
  return { delivered: ageNewAcc_(), returnClosed: ageNewAcc_(), returnOpen: ageNewAcc_(), inProgress: ageNewAcc_(), other: ageNewAcc_() };
}
function ageFinalizeKindAccs_(k) {
  return { delivered: ageFinalizeAcc_(k.delivered), returnClosed: ageFinalizeAcc_(k.returnClosed),
    returnOpen: ageFinalizeAcc_(k.returnOpen), inProgress: ageFinalizeAcc_(k.inProgress), other: ageFinalizeAcc_(k.other) };
}
function ageSumKinds_(k) { return k.delivered.count + k.returnClosed.count + k.returnOpen.count + k.inProgress.count + k.other.count; }

// Resolves the effective groups, applying optional overrides
// {cairo:{market,delivery,returns}, ...}. Non-positive / non-numeric values are ignored.
function ageResolveGroups_(overrides) {
  var out = [];
  for (var i = 0; i < AGE_REPORT_GROUPS.length; i++) {
    var g = AGE_REPORT_GROUPS[i], o = (overrides && overrides[g.key]) || {};
    function pick(v, d) { var n = Number(v); return (v !== undefined && v !== null && v !== "" && isFinite(n) && n > 0) ? n : d; }
    out.push({ key: g.key, name: g.name, branches: g.branches,
      market: pick(o.market, g.marketDays), delivery: pick(o.delivery, g.companyDeliveryDays), returns: pick(o.returns, g.companyReturnDays) });
  }
  return out;
}

// records: [{awb, branch, status, pickup:Date, lastStatus:Date|null}] — already de-duplicated and pickup-range filtered.
function ageReportCompute_(records, groups, asOfNum) {
  var branchToGroup = {}, groupIdx = {}, gi, bi;
  var state = [];
  for (gi = 0; gi < groups.length; gi++) {
    groupIdx[groups[gi].key] = gi;
    for (bi = 0; bi < groups[gi].branches.length; bi++) branchToGroup[ageNormBranch_(groups[gi].branches[bi])] = gi;
    var dist = []; for (var di = 0; di <= groups[gi].delivery; di++) dist.push(0); // buckets: 1..delivery, then (delivery+1) = beyond company standard
    state.push({ kinds: ageNewKindAccs_(), branches: {}, branchOrder: [], dist: dist });
  }
  var unassigned = { kinds: ageNewKindAccs_(), branches: {}, branchOrder: [] };
  var unmappedBranches = {};
  var total = ageNewKindAccs_();
  var statusBreakdown = {};
  var dq = { invalidPickup: 0, closedWithoutEndDate: 0, negativeAge: 0, missingBranch: 0 };
  var openList = [];
  var minRetAge = null, maxRetAge = null;
  var sumOpenAge = 0, openAgeN = 0, sumPendAge = 0, pendAgeN = 0, sumRetAge = 0, retAgeN = 0;
  var branchOpenAgg = {};

  for (var r = 0; r < records.length; r++) {
    var rec = records[r];
    var kind = ageClassify_(rec.status);
    var sKey = rec.status || "(بدون حالة)";
    if (!statusBreakdown[sKey]) statusBreakdown[sKey] = { count: 0, kind: kind };
    statusBreakdown[sKey].count++;

    var bNorm = ageNormBranch_(rec.branch);
    var gIndex = bNorm && branchToGroup.hasOwnProperty(bNorm) ? branchToGroup[bNorm] : -1;
    var gs = gIndex >= 0 ? state[gIndex] : unassigned;
    var std = gIndex >= 0 ? groups[gIndex] : null;
    if (!rec.branch) dq.missingBranch++;
    else if (gIndex < 0) unmappedBranches[rec.branch] = (unmappedBranches[rec.branch] || 0) + 1;

    var branchLabel = rec.branch ? summaryNormText(rec.branch).replace(/^فرع\s+/, "") : "غير محدد";
    if (gIndex >= 0) {
      for (bi = 0; bi < groups[gIndex].branches.length; bi++) {
        if (ageNormBranch_(groups[gIndex].branches[bi]) === bNorm) { branchLabel = groups[gIndex].branches[bi]; break; }
      }
    }
    if (!gs.branches[branchLabel]) { gs.branches[branchLabel] = ageNewKindAccs_(); gs.branchOrder.push(branchLabel); }

    // age
    var age = null;
    var isOpen = kind === "inProgress" || kind === "returnOpen";
    if (!rec.pickup) { dq.invalidPickup++; }
    else if (kind !== "other") {
      var pNum = ageDayNum_(rec.pickup);
      if (isOpen) age = asOfNum - pNum;
      else if (rec.lastStatus) age = ageDayNum_(rec.lastStatus) - pNum;
      else dq.closedWithoutEndDate++;
      if (age !== null && age < 0) { dq.negativeAge++; age = null; }
    }

    // groups with no std (unassigned) fall back to the first group's standards ONLY for the over/within split display, never silently:
    // they are reported under "غير مصنّف" with age statistics only.
    var effStd = std || { market: -1, delivery: -1, returns: -1 };
    if (std && kind === "delivered" && age !== null) {
      // delivery-day histogram: age 0/1 -> bucket 1, age n -> bucket n, > company standard -> last bucket
      var bucketIdx = age <= 1 ? 0 : (age <= std.delivery ? age - 1 : std.delivery);
      gs.dist[bucketIdx]++;
    }
    ageAddToAcc_(gs.kinds[kind], kind, age, effStd);
    ageAddToAcc_(gs.branches[branchLabel][kind], kind, age, effStd);
    if (std) ageAddToAcc_(total[kind], kind, age, effStd);

    if (isOpen && age !== null) {
      sumOpenAge += age; openAgeN++;
      if (kind === "inProgress") { sumPendAge += age; pendAgeN++; } else { sumRetAge += age; retAgeN++; if (minRetAge === null || age < minRetAge) minRetAge = age; if (maxRetAge === null || age > maxRetAge) maxRetAge = age; }
    }
    if (isOpen) {
      var limit = std ? (kind === "inProgress" ? std.delivery : std.returns) : null;
      var overdue = (limit !== null && age !== null) ? age > limit : false;
      var bo = branchOpenAgg[branchLabel] || (branchOpenAgg[branchLabel] = { branch: branchLabel, group: std ? std.name : "غير مصنّف", pending: 0, pendingOver: 0, ret: 0, retOver: 0 });
      if (kind === "inProgress") { bo.pending++; if (overdue) bo.pendingOver++; } else { bo.ret++; if (overdue) bo.retOver++; }
      openList.push({ awb: rec.awb, branch: branchLabel, group: std ? std.name : "غير مصنّف", status: rec.status, kind: kind,
        pickup: rec.pickup ? ageIsoDate_(rec.pickup) : null, age: age, limit: limit, overdue: overdue });
    }
  }

  // ---- finalize ----
  var outGroups = [];
  function finalizeGroup(gs, meta) {
    var kinds = ageFinalizeKindAccs_(gs.kinds);
    var gTotal = ageSumKinds_(gs.kinds);
    var branches = [];
    for (var b = 0; b < gs.branchOrder.length; b++) {
      var name = gs.branchOrder[b], bk = gs.branches[name];
      branches.push({ name: name, total: ageSumKinds_(bk), kinds: ageFinalizeKindAccs_(bk) });
    }
    branches.sort(function (x, y) { return y.total - x.total; });
    var within = gs.kinds.delivered.withinCompany + gs.kinds.returnClosed.withinCompany + gs.kinds.returnOpen.withinCompany + gs.kinds.inProgress.withinCompany;
    var over = gs.kinds.delivered.over + gs.kinds.returnClosed.over + gs.kinds.returnOpen.over + gs.kinds.inProgress.over;
    return Object.assign({ total: gTotal, kinds: kinds, branches: branches, dist: gs.dist || null,
      withinCompany: within, over: over,
      withinPct: gTotal > 0 ? within / gTotal * 100 : null, overPct: gTotal > 0 ? over / gTotal * 100 : null }, meta);
  }
  var grandTotal = 0, gj;
  for (gj = 0; gj < state.length; gj++) grandTotal += ageSumKinds_(state[gj].kinds);
  var unassignedTotal = ageSumKinds_(unassigned.kinds);
  grandTotal += unassignedTotal;
  for (gj = 0; gj < groups.length; gj++) {
    var fg = finalizeGroup(state[gj], { key: groups[gj].key, name: groups[gj].name, market: groups[gj].market, delivery: groups[gj].delivery, returns: groups[gj].returns });
    fg.sharePct = grandTotal > 0 ? fg.total / grandTotal * 100 : null;
    outGroups.push(fg);
  }
  var outUnassigned = null;
  if (unassignedTotal > 0) {
    outUnassigned = finalizeGroup(unassigned, { key: "unassigned", name: "غير مصنّف (فرع غير مدرج في المجموعات)", market: null, delivery: null, returns: null });
    outUnassigned.sharePct = grandTotal > 0 ? unassignedTotal / grandTotal * 100 : null;
  }

  // company-wide KPIs (assigned groups only; unassigned shipments are counted in `shipments` and flagged)
  var kt = total;
  var closedUnassigned = unassigned.kinds;
  var delivered = kt.delivered.count + closedUnassigned.delivered.count;
  var returnClosed = kt.returnClosed.count + closedUnassigned.returnClosed.count;
  var returnOpen = kt.returnOpen.count + closedUnassigned.returnOpen.count;
  var inProgress = kt.inProgress.count + closedUnassigned.inProgress.count;
  var otherCount = kt.other.count + closedUnassigned.other.count;
  var returns = returnClosed + returnOpen;
  function pct(n, d) { return d > 0 ? n / d * 100 : null; }
  var openTotal = inProgress + returnOpen;
  var overdueOpen = kt.inProgress.over + kt.returnOpen.over;
  var kpis = {
    shipments: grandTotal,
    delivered: delivered, deliveredPct: pct(delivered, grandTotal),
    deliveredWithinMarket: kt.delivered.withinMarket, deliveredWithinMarketPct: pct(kt.delivered.withinMarket, delivered),
    deliveredWithinCompany: kt.delivered.withinCompany, deliveredWithinCompanyPct: pct(kt.delivered.withinCompany, delivered),
    avgDeliveryAge: ageFinalizeAcc_(kt.delivered).avgAge,
    returns: returns, returnsPct: pct(returns, grandTotal),
    returnClosed: returnClosed, returnClosedWithin: kt.returnClosed.withinCompany, returnClosedWithinPct: pct(kt.returnClosed.withinCompany, returns),
    returnClosedOver: kt.returnClosed.over, returnClosedOverPct: pct(kt.returnClosed.over, returns),
    returnOpen: returnOpen, returnOpenPct: pct(returnOpen, returns),
    avgReturnClosedAge: ageFinalizeAcc_(kt.returnClosed).avgAge,
    open: openTotal, inProgress: inProgress,
    openOverdue: overdueOpen, openOverduePct: pct(overdueOpen, openTotal),
    inProgressOverdue: kt.inProgress.over, inProgressOverduePct: pct(kt.inProgress.over, inProgress),
    returnOpenOverdue: kt.returnOpen.over, returnOpenOverduePct: pct(kt.returnOpen.over, returnOpen),
    avgOpenAge: openAgeN > 0 ? sumOpenAge / openAgeN : null,
    avgInProgressAge: pendAgeN > 0 ? sumPendAge / pendAgeN : null,
    avgOpenReturnAge: retAgeN > 0 ? sumRetAge / retAgeN : null,
    minOpenReturnAge: minRetAge, maxOpenReturnAge: maxRetAge,
    other: otherCount
  };

  // open overview by group + top branches by overdue
  var openByGroup = [];
  for (gj = 0; gj < outGroups.length; gj++) {
    var og = outGroups[gj], ik = og.kinds.inProgress, rk = og.kinds.returnOpen;
    var openN = ik.count + rk.count, overN = ik.over + rk.over;
    openByGroup.push({ key: og.key, name: og.name, delivery: og.delivery, returns: og.returns,
      inProgress: ik.count, inProgressOver: ik.over, inProgressOverPct: ik.overPct,
      returnOpen: rk.count, returnOpenOver: rk.over, returnOpenOverPct: rk.overPct,
      overTotal: overN, overPctOfOpen: openN > 0 ? overN / openN * 100 : null });
  }
  var topBranches = [];
  for (var bk2 in branchOpenAgg) {
    if (!branchOpenAgg.hasOwnProperty(bk2)) continue;
    var x = branchOpenAgg[bk2], openB = x.pending + x.ret, overB = x.pendingOver + x.retOver;
    topBranches.push({ branch: x.branch, group: x.group, inProgress: x.pending, inProgressOver: x.pendingOver, returnOpen: x.ret, returnOpenOver: x.retOver,
      overTotal: overB, overPctOfOpen: openB > 0 ? overB / openB * 100 : null });
  }
  topBranches.sort(function (a, b) { return b.overTotal - a.overTotal; });
  topBranches = topBranches.slice(0, 5);

  openList.sort(function (a, b) {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return (b.age === null ? -1 : b.age) - (a.age === null ? -1 : a.age);
  });
  var openListTruncated = openList.length > AGE_REPORT_MAX_OPEN_LIST;
  if (openListTruncated) openList = openList.slice(0, AGE_REPORT_MAX_OPEN_LIST);

  return {
    kpis: kpis, groups: outGroups, unassigned: outUnassigned,
    open: { byGroup: openByGroup, topBranches: topBranches, list: openList, listTruncated: openListTruncated },
    statusBreakdown: statusBreakdown,
    dq: { invalidPickup: dq.invalidPickup, closedWithoutEndDate: dq.closedWithoutEndDate, negativeAge: dq.negativeAge, missingBranch: dq.missingBranch, unmappedBranches: unmappedBranches }
  };
}

function ageReportMonthsInRange_(fromNum, toNum) {
  var out = [], seen = {};
  for (var n = fromNum; n <= toNum; n += 1) {
    var d = new Date(n * 86400000);
    var key = d.getUTCFullYear() + "-" + d.getUTCMonth();
    if (!seen[key]) { seen[key] = true; out.push(MONTH_ORDER[d.getUTCMonth()]); }
    if (out.length > AGE_REPORT_MAX_MONTHS) break;
  }
  return out;
}

function getAgeReport(params) {
  var t0 = new Date().getTime();
  var isoRe = /^\d{4}-\d{2}-\d{2}$/;
  var dateFrom = summaryNormText(params && params.dateFrom), dateTo = summaryNormText(params && params.dateTo);
  var asOf = summaryNormText(params && params.asOf);
  if (!isoRe.test(asOf)) asOf = ageIsoDate_(new Date());
  var asOfNum = ageDayNumFromIso_(asOf);

  var overrides = {};
  if (params && params.standards) { try { overrides = JSON.parse(params.standards) || {}; } catch (e) { overrides = {}; } }
  var groups = ageResolveGroups_(overrides);

  // Two modes:
  //  - sheets mode (dashboard-linked): `sheets=July` or `sheets=January,February,...` (All Months). Whole month sheets are read;
  //    dateFrom/dateTo are OPTIONAL extra pickup-date bounds (the dashboard's own date filter).
  //  - legacy range mode: dateFrom + dateTo required; the months overlapping the range are read.
  var sheetsParam = summaryNormText(params && params.sheets);
  var months, fromNum = null, toNum = null, sheetsMode = !!sheetsParam;
  if (dateFrom && !isoRe.test(dateFrom)) return { success: false, error: "تاريخ البداية بصيغة غير صحيحة (YYYY-MM-DD)." };
  if (dateTo && !isoRe.test(dateTo)) return { success: false, error: "تاريخ النهاية بصيغة غير صحيحة (YYYY-MM-DD)." };
  if (dateFrom) fromNum = ageDayNumFromIso_(dateFrom);
  if (dateTo) toNum = ageDayNumFromIso_(dateTo);
  if (fromNum !== null && toNum !== null && toNum < fromNum) return { success: false, error: "تاريخ النهاية قبل تاريخ البداية." };
  if (sheetsMode) {
    var wanted = {};
    sheetsParam.split(",").forEach(function (m) { m = summaryNormText(m); if (MONTH_SOURCE.hasOwnProperty(m)) wanted[m] = true; });
    months = MONTH_ORDER.filter(function (m) { return wanted[m]; });
    if (!months.length) return { success: false, error: "لم يتم تحديد شهر صالح." };
  } else {
    if (fromNum === null || toNum === null) return { success: false, error: "يجب تحديد الشهر (sheets) أو تاريخ البداية والنهاية بصيغة YYYY-MM-DD." };
    if (asOfNum < toNum) return { success: false, error: "تاريخ القياس يجب ألا يسبق نهاية الفترة." };
    months = ageReportMonthsInRange_(fromNum, toNum);
    if (months.length > AGE_REPORT_MAX_MONTHS) return { success: false, error: "الفترة أطول من " + AGE_REPORT_MAX_MONTHS + " شهور — قلّل المدى." };
  }

  var cache = CacheService.getScriptCache();
  var forceRefresh = !!(params && (params.refresh === "1" || params.refresh === "true"));
  var cacheKey = "agerep_v4_g" + getSnapshotGenerationStamp_() + "_" + summaryHashKey((sheetsMode ? months.join(",") : "") + "|" + dateFrom + "|" + dateTo + "|" + asOf + "|" + JSON.stringify(groups.map(function (g) { return [g.market, g.delivery, g.returns]; })));
  if (!forceRefresh) {
    var cached = cacheGetChunked(cache, cacheKey);
    if (cached) { var co = JSON.parse(cached); co.cached = true; return co; }
  }

  var awbMap = {}, rowsRead = 0, dupRemoved = 0, outOfRange = 0, noAwb = 0;
  var snapRecords = [], sources = [], snapMin = null, snapMax = null;
  var forceLive = !!(params && (params.live === "1" || params.live === "true"));
  var useSnapshots = sheetsMode && fromNum === null && toNum === null && !forceLive; // a date filter (or live=1) needs the raw rows; refresh=1 only skips the result cache
  var missingMonths = [], monthsRead = [], skippedMonths = [];
  for (var mi = 0; mi < months.length; mi++) {
    var month = months[mi];
    if (new Date().getTime() - t0 > AGE_REPORT_TIME_BUDGET_MS) { skippedMonths.push(month); continue; } // never risk the Apps Script execution ceiling — reported, not hidden
    var quarter = MONTH_SOURCE[month];
    var ss;
    try { ss = SpreadsheetApp.openById(SPREADSHEET_IDS[quarter]); }
    catch (err) { return { success: false, error: "تعذر فتح Spreadsheet " + quarter + ": " + String(err && err.message ? err.message : err) }; }
    if (useSnapshots) {
      var snap = null;
      try { snap = ageGetSnapshot_(month); } catch (eSnap) { snap = null; }
      if (snap) {
        ageSnapshotToRecords_(snap, snapRecords);
        rowsRead += snap.rowsRead; dupRemoved += snap.duplicates; noAwb += snap.blankAwb;
        if (snap.minPickup && (snapMin === null || snap.minPickup < snapMin)) snapMin = snap.minPickup;
        if (snap.maxPickup && (snapMax === null || snap.maxPickup > snapMax)) snapMax = snap.maxPickup;
        monthsRead.push(month); sources.push({ month: month, source: "snapshot", generatedAt: snap.generatedAt });
        continue;
      }
    }
    var sheet = ss.getSheetByName(month);
    if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) { missingMonths.push(month); continue; }
    var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
    var headers = values[0];
    var colMap = summaryDetectColumnMap(headers), idx = {}, mapped = Object.keys(colMap);
    for (var f = 0; f < mapped.length; f++) idx[mapped[f]] = headers.indexOf(colMap[mapped[f]]);
    if (idx.awb === undefined || idx.pickup === undefined || idx.status === undefined) {
      return { success: false, error: "أعمدة مطلوبة غير موجودة في شيت " + month + " (رقم البوليصة / تاريخ البيك أب / حالة الشحنة)." };
    }
    monthsRead.push(month); sources.push({ month: month, source: "live", generatedAt: null });
    for (var ri = 1; ri < values.length; ri++) {
      var row = values[ri];
      if (summaryRowIsAllEmpty(row)) continue;
      rowsRead++;
      var awb = summaryNormText(summaryGetField(row, idx, "awb"));
      if (!awb) { noAwb++; continue; }
      var pickup = summaryParseDate(summaryGetField(row, idx, "pickup"));
      if (pickup) { var pn = ageDayNum_(pickup); if ((fromNum !== null && pn < fromNum) || (toNum !== null && pn > toNum)) { outOfRange++; continue; } }
      var rec = {
        awb: awb, pickup: pickup, lastStatus: summaryParseDate(summaryGetField(row, idx, "lastStatus")),
        branch: summaryNormText(summaryGetField(row, idx, "branch")), status: summaryEffectiveStatus_(summaryGetField(row, idx, "status"), summaryGetField(row, idx, "finalStatus"))
      };
      if (awbMap.hasOwnProperty(awb)) {
        dupRemoved++;
        var et = awbMap[awb].lastStatus ? awbMap[awb].lastStatus.getTime() : -Infinity;
        var rt = rec.lastStatus ? rec.lastStatus.getTime() : -Infinity;
        if (rt >= et) awbMap[awb] = rec;
      } else awbMap[awb] = rec;
    }
  }

  var records = snapRecords;
  for (var k in awbMap) { if (awbMap.hasOwnProperty(k)) records.push(awbMap[k]); }
  var minP = snapMin ? ageDayNumFromIso_(snapMin) : null, maxP = snapMax ? ageDayNumFromIso_(snapMax) : null;
  for (var lk in awbMap) { // live-read rows only (snapshot rows carry placeholder dates; their range comes from the snapshot)
    if (!awbMap.hasOwnProperty(lk) || !awbMap[lk].pickup) continue;
    var pnum = ageDayNum_(awbMap[lk].pickup);
    if (minP === null || pnum < minP) minP = pnum;
    if (maxP === null || pnum > maxP) maxP = pnum;
  }
  var computed = ageReportCompute_(records, groups, asOfNum);
  var result = {
    success: true, generatedAt: new Date().toISOString(), cached: false,
    params: { dateFrom: minP !== null ? ageIsoFromDayNum_(minP) : dateFrom, dateTo: maxP !== null ? ageIsoFromDayNum_(maxP) : dateTo, asOf: asOf,
      boundFrom: dateFrom, boundTo: dateTo, scope: sheetsMode ? "sheets" : "range" },
    standards: groups.map(function (g) { return { key: g.key, name: g.name, market: g.market, delivery: g.delivery, returns: g.returns }; }),
    months: monthsRead, missingMonths: missingMonths, skippedMonths: skippedMonths, sources: sources,
    kpis: computed.kpis, groups: computed.groups, unassigned: computed.unassigned, open: computed.open,
    statusBreakdown: computed.statusBreakdown,
    dq: Object.assign({ rowsRead: rowsRead, uniqueShipments: records.length, duplicatesRemoved: dupRemoved, outsidePeriod: outOfRange, blankAwb: noAwb }, computed.dq),
    durationMs: new Date().getTime() - t0
  };
  try {
    var ser = JSON.stringify(result);
    if (ser.length < 2500000) cachePutChunked(cache, cacheKey, ser, AGE_REPORT_CACHE_TTL_SECONDS);
  } catch (eCache) { /* non-fatal */ }
  return result;
}


// ------------------------------------------------------------
// 5D-2. AGE REPORT — PERSISTENT SNAPSHOTS (ملخص عمر الشحنة المحفوظ في الشيتات)
//
// Same idea as the main dashboard's DASHBOARD_SUMMARY: the heavy raw-sheet
// read is done ONCE (by the menu function / trigger below) and stored in a tab
// named AGE_SUMMARY inside each quarter spreadsheet. The age report then reads
// that compact snapshot instead of re-reading 100k+ raw rows on every request.
//
// What is stored per month (after de-duplicating AWB inside the month):
//   closed shipments  -> aggregated counts per [branch, status, age-in-days]
//   open shipments    -> one row each [awb, branch, status, pickupDate]  (their age
//                        depends on the report's measurement date, so it is computed at read time)
// Status classification, group mapping and standards are applied at READ time, so changing
// the standards / branch groups needs no rebuild. Changing the SUMMARY_RETURN_* / rejection rules DOES need a rebuild.
// A month with no snapshot (or a request with a date filter / refresh=1) falls back to a live raw read.
// Limitation: AWBs repeated across two different months are not de-duplicated in snapshot mode.
// ------------------------------------------------------------
var AGE_SNAPSHOT_SHEET = "AGE_SUMMARY";
var AGE_SNAPSHOT_VERSION = "2"; // 2 = status stored as the effective status (rejection from the final-status column)
var AGE_SNAPSHOT_CHUNK = 45000;
var AGE_SNAPSHOT_BATCH_BUDGET_MS = 270000;

function ageSnapshotSheet_(quarter) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_IDS[quarter]);
  var sh = ss.getSheetByName(AGE_SNAPSHOT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(AGE_SNAPSHOT_SHEET);
    sh.getRange(1, 1, 1, 6).setValues([["Month", "Version", "Generated At", "Chunk Index", "Chunk Count", "JSON Chunk"]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function ageGetSnapshot_(month) {
  if (!MONTH_SOURCE.hasOwnProperty(month)) return null;
  var ss = SpreadsheetApp.openById(SPREADSHEET_IDS[MONTH_SOURCE[month]]);
  var sh = ss.getSheetByName(AGE_SNAPSHOT_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
  var parts = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === month && String(rows[i][1] || "") === AGE_SNAPSHOT_VERSION) parts.push(rows[i]);
  }
  if (!parts.length) return null;
  parts.sort(function (a, b) { return Number(a[3]) - Number(b[3]); });
  var expected = Number(parts[0][4]) || 0;
  if (!expected || parts.length !== expected) return null;
  var json = "";
  for (var j = 0; j < parts.length; j++) {
    if (Number(parts[j][3]) !== j) return null;
    json += String(parts[j][5] || "");
  }
  try { return JSON.parse(json); } catch (e) { console.log("[AGE SNAPSHOT INVALID] " + month + " " + String(e)); return null; }
}

function ageSaveSnapshot_(month, snap) {
  var sh = ageSnapshotSheet_(MONTH_SOURCE[month]);
  var json = JSON.stringify(snap), chunks = [];
  for (var i = 0; i < json.length; i += AGE_SNAPSHOT_CHUNK) chunks.push(json.substring(i, i + AGE_SNAPSHOT_CHUNK));
  if (!chunks.length) chunks.push("{}");
  var last = sh.getLastRow();
  if (last >= 2) {
    var existing = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var r = existing.length - 1; r >= 0; r--) {
      if (String(existing[r][0] || "").trim() === month) sh.deleteRow(r + 2);
    }
  }
  var values = [];
  for (var c = 0; c < chunks.length; c++) values.push([month, AGE_SNAPSHOT_VERSION, snap.generatedAt, c, chunks.length, chunks[c]]);
  sh.getRange(sh.getLastRow() + 1, 1, values.length, 6).setValues(values);
  SpreadsheetApp.flush();
  bumpSnapshotGenerationStamp_(); // invalidates cached age-report results (their cache key includes this stamp)
  return chunks.length;
}

function ageBuildSnapshot_(month) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_IDS[MONTH_SOURCE[month]]);
  var sheet = ss.getSheetByName(month);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return { success: false, error: "الشيت غير موجود أو فارغ: " + month };
  var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  var headers = values[0], colMap = summaryDetectColumnMap(headers), idx = {}, mapped = Object.keys(colMap);
  for (var f = 0; f < mapped.length; f++) idx[mapped[f]] = headers.indexOf(colMap[mapped[f]]);
  if (idx.awb === undefined || idx.pickup === undefined || idx.status === undefined) {
    return { success: false, error: "أعمدة مطلوبة غير موجودة في شيت " + month + " (رقم البوليصة / تاريخ البيك أب / حالة الشحنة)." };
  }
  var awbMap = {}, rowsRead = 0, dup = 0, noAwb = 0;
  for (var ri = 1; ri < values.length; ri++) {
    var row = values[ri];
    if (summaryRowIsAllEmpty(row)) continue;
    rowsRead++;
    var awb = summaryNormText(summaryGetField(row, idx, "awb"));
    if (!awb) { noAwb++; continue; }
    var rec = { awb: awb, pickup: summaryParseDate(summaryGetField(row, idx, "pickup")), lastStatus: summaryParseDate(summaryGetField(row, idx, "lastStatus")),
      branch: summaryNormText(summaryGetField(row, idx, "branch")), status: summaryEffectiveStatus_(summaryGetField(row, idx, "status"), summaryGetField(row, idx, "finalStatus")) };
    if (awbMap.hasOwnProperty(awb)) {
      dup++;
      var et = awbMap[awb].lastStatus ? awbMap[awb].lastStatus.getTime() : -Infinity;
      var rt = rec.lastStatus ? rec.lastStatus.getTime() : -Infinity;
      if (rt >= et) awbMap[awb] = rec;
    } else awbMap[awb] = rec;
  }
  var closedAgg = {}, closedKeys = [], open = [], unique = 0, minP = null, maxP = null;
  for (var k in awbMap) {
    if (!awbMap.hasOwnProperty(k)) continue;
    var r = awbMap[k]; unique++;
    var kind = ageClassify_(r.status);
    var pn = r.pickup ? ageDayNum_(r.pickup) : null;
    if (pn !== null) { if (minP === null || pn < minP) minP = pn; if (maxP === null || pn > maxP) maxP = pn; }
    if (kind === "inProgress" || kind === "returnOpen") {
      open.push([r.awb, r.branch, r.status, r.pickup ? ageIsoDate_(r.pickup) : null]);
      continue;
    }
    var age;
    if (pn === null) age = "P";                       // missing / invalid pickup date
    else if (kind === "other") age = 0;               // age is not used for "other" statuses
    else if (!r.lastStatus) age = "E";                // closed but no last-status date
    else age = ageDayNum_(r.lastStatus) - pn;         // may be negative -> flagged by the report
    var key = r.branch + "\u0001" + r.status + "\u0001" + age;
    if (!closedAgg[key]) { closedAgg[key] = [r.branch, r.status, age, 0]; closedKeys.push(key); }
    closedAgg[key][3]++;
  }
  var closed = closedKeys.map(function (kk) { return closedAgg[kk]; });
  return { success: true, snapshot: { version: AGE_SNAPSHOT_VERSION, month: month, generatedAt: new Date().toISOString(),
    rowsRead: rowsRead, blankAwb: noAwb, duplicates: dup, unique: unique,
    minPickup: minP !== null ? ageIsoFromDayNum_(minP) : null, maxPickup: maxP !== null ? ageIsoFromDayNum_(maxP) : null,
    closed: closed, open: open } };
}

function ageSnapshotToRecords_(snap, out) {
  var base = new Date(2000, 0, 1), lastCache = {}, i;
  function lastFor(age) { if (!lastCache.hasOwnProperty(age)) lastCache[age] = new Date(2000, 0, 1 + age); return lastCache[age]; }
  for (i = 0; i < snap.closed.length; i++) {
    var c = snap.closed[i], age = c[2], pickup = base, last = null;
    if (age === "P") pickup = null;
    else if (age === "E") last = null;
    else last = lastFor(age);
    for (var n = 0; n < c[3]; n++) out.push({ awb: "S", branch: c[0], status: c[1], pickup: pickup, lastStatus: last });
  }
  for (i = 0; i < snap.open.length; i++) {
    var o = snap.open[i], pd = null;
    if (o[3]) { var p = o[3].split("-"); pd = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
    out.push({ awb: o[0], branch: o[1], status: o[2], pickup: pd, lastStatus: null });
  }
}

// Wall-clock start of THIS execution (globals are re-initialised on every Apps Script execution).
var AGE_EXECUTION_START_MS = new Date().getTime();
var AGE_WITH_SUMMARY_MAX_START_MS = 215000; // do not START an age build this late in a run — the 6-minute ceiling is shared with the main build

function ageSnapshotWithSummary_(month, mainSummary) {
  try {
    if (mainSummary && (mainSummary.empty || mainSummary.noData)) return { success: true, skipped: "empty-month" };
    if (new Date().getTime() - AGE_EXECUTION_START_MS > AGE_WITH_SUMMARY_MAX_START_MS) {
      return { success: false, skipped: "time-budget", note: "شغّل «Age Report: Build Missing Months Summary» لاستكمال ملخص عمر الشحنة" };
    }
    var r = buildAgeSnapshot(month);
    return r.success ? { success: true, openShipments: r.openShipments, durationMs: r.durationMs } : { success: false, error: r.error };
  } catch (e) {
    console.log("[AGE SNAPSHOT WITH SUMMARY FAILED] " + month + " " + String(e));
    return { success: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---- builders (menu / trigger / doGet) ----
function buildAgeSnapshot(month) {
  if (!MONTH_SOURCE.hasOwnProperty(month)) return { success: false, error: "شهر غير معروف: " + month };
  var t0 = new Date().getTime();
  var built = ageBuildSnapshot_(month);
  if (!built.success) return built;
  var chunks = ageSaveSnapshot_(month, built.snapshot);
  var sn = built.snapshot;
  return { success: true, month: month, uniqueShipments: sn.unique, openShipments: sn.open.length, closedRowsAggregated: sn.closed.length,
    chunks: chunks, generatedAt: sn.generatedAt, durationMs: new Date().getTime() - t0 };
}

// Builds snapshots for the given months, stopping before the Apps Script time ceiling. Months not reached are listed.
function ageBuildSnapshotsFor_(months) {
  var t0 = new Date().getTime(), done = [], failed = [], notReached = [];
  for (var i = 0; i < months.length; i++) {
    if (new Date().getTime() - t0 > AGE_SNAPSHOT_BATCH_BUDGET_MS) { notReached.push(months[i]); continue; }
    try {
      var r = buildAgeSnapshot(months[i]);
      if (r.success) done.push(months[i]); else failed.push({ month: months[i], error: r.error });
    } catch (e) { failed.push({ month: months[i], error: String(e && e.message ? e.message : e) }); }
  }
  var res = { success: failed.length === 0, done: done, failed: failed, notReached: notReached, durationMs: new Date().getTime() - t0 };
  console.log("[AGE SNAPSHOTS] " + JSON.stringify(res));
  return res;
}

// ▶ Run from the "ARRIVE Dashboard" menu (or Apps Script editor): updates the age summary of the CURRENT quarter's months.
function updateCurrentQuarterAgeSnapshots() {
  var q = Math.floor(new Date().getMonth() / 3), months = MONTH_ORDER.slice(q * 3, q * 3 + 3);
  return ageBuildSnapshotsFor_(months);
}
// ▶ Updates the age summary of all 12 months (months with no data are reported as failed/empty; re-run to continue if some were not reached).
function buildAllAgeSnapshots() { return ageBuildSnapshotsFor_(MONTH_ORDER.slice()); }
// ▶ Builds only the months that have no age snapshot yet.
function buildMissingAgeSnapshots() {
  var missing = MONTH_ORDER.filter(function (m) { try { return !ageGetSnapshot_(m); } catch (e) { return true; } });
  return ageBuildSnapshotsFor_(missing);
}
// ▶ Single month, e.g. run from the editor after editing the month name below.
function buildAgeSnapshotOctober() { return buildAgeSnapshot("October"); }


// ============================================================
// STATUS NAMES — أسماء الحالات المكتوبة فعليًا في الشيتات
// ▶ شغّلها من قائمة ARRIVE Dashboard ← "List Status Names" (أو من محرر Apps Script).
// تمر على شهور الملف المفتوح (Q1/Q2/Q3/Q4) وتكتب تبويب اسمه STATUS_NAMES فيه كل اسم حالة
// مع عدد الشحنات (بعد حذف تكرار رقم البوليصة) وتصنيفه في الداشبورد وفي تقرير عمر الشحنة.
// الحالات «غير مصنف» هي التي يصنفها الداشبورد unknown.
// ============================================================
var STATUS_NAMES_SHEET = "STATUS_NAMES";
var AGE_KIND_LABELS_AR_ = { delivered: "تسليم ناجح", returnClosed: "مرتجع مغلق", returnOpen: "مرتجع مفتوح", inProgress: "قيد التشغيل", other: "أخرى (خارج المعايير)" };
var DASH_KIND_LABELS_AR_ = { delivered: "تسليم", returnClosed: "مرتجع مغلق", returnOpen: "مرتجع مفتوح", returnHold: "مرتجع معلق", inProgress: "قيد التشغيل", rejected: "رفض (من الحالة النهائية)", unknown: "غير مصنف" };

function collectStatusNames_(ss, months) {
  var rows = [], finals = [], monthsRead = [];
  for (var m = 0; m < months.length; m++) {
    var sheet = ss.getSheetByName(months[m]);
    if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) continue;
    var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
    var headers = values[0], colMap = summaryDetectColumnMap(headers), idx = {}, mapped = Object.keys(colMap);
    for (var f = 0; f < mapped.length; f++) idx[mapped[f]] = headers.indexOf(colMap[mapped[f]]);
    if (idx.status === undefined) continue;
    monthsRead.push(months[m]);
    var byAwb = {}, noAwb = [];
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      if (summaryRowIsAllEmpty(row)) continue;
      var fsv = summaryNormText(summaryGetField(row, idx, "finalStatus"));
      var st = summaryEffectiveStatus_(summaryGetField(row, idx, "status"), fsv);
      var awb = summaryNormText(summaryGetField(row, idx, "awb"));
      if (!awb) continue;
      var last = summaryParseDate(summaryGetField(row, idx, "lastStatus"));
      var prev = byAwb[awb];
      if (!prev || (last ? last.getTime() : -Infinity) >= prev.t) byAwb[awb] = { s: st, f: fsv, t: last ? last.getTime() : -Infinity };
    }
    var counts = {}, finalCounts = {};
    for (var a in byAwb) { if (byAwb.hasOwnProperty(a)) {
      var k = byAwb[a].s || "(فارغ)"; counts[k] = (counts[k] || 0) + 1;
      var fk = byAwb[a].f || "(فارغ)"; finalCounts[fk] = (finalCounts[fk] || 0) + 1;
    } }
    for (var fname in finalCounts) { if (finalCounts.hasOwnProperty(fname)) finals.push({ month: months[m], finalStatus: fname, count: finalCounts[fname] }); }
    for (var name in counts) {
      if (!counts.hasOwnProperty(name)) continue;
      var real = name === "(فارغ)" ? "" : name;
      rows.push({ month: months[m], status: name, count: counts[name],
        dashboard: DASH_KIND_LABELS_AR_[summaryClassifyKind(real)], age: AGE_KIND_LABELS_AR_[ageClassify_(real)] });
    }
  }
  rows.sort(function (x, y) { return MONTH_ORDER.indexOf(x.month) - MONTH_ORDER.indexOf(y.month) || y.count - x.count; });
  finals.sort(function (x, y) { return MONTH_ORDER.indexOf(x.month) - MONTH_ORDER.indexOf(y.month) || y.count - x.count; });
  return { rows: rows, finals: finals, monthsRead: monthsRead };
}

function listStatusNames() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), id = ss.getId(), quarter = null;
  for (var q in SPREADSHEET_IDS) { if (SPREADSHEET_IDS[q] === id) quarter = q; }
  if (!quarter) throw new Error("هذا الملف ليس أحد ملفات Q1/Q2/Q3/Q4.");
  var months = MONTH_ORDER.filter(function (mo) { return MONTH_SOURCE[mo] === quarter; });
  var res = collectStatusNames_(ss, months);
  var out = ss.getSheetByName(STATUS_NAMES_SHEET) || ss.insertSheet(STATUS_NAMES_SHEET);
  out.clear();
  var table = [["الشهر", "اسم الحالة (كما هو مكتوب)", "عدد الشحنات", "تصنيفه في الداشبورد", "تصنيفه في تقرير عمر الشحنة"]];
  res.rows.forEach(function (r) { table.push([r.month, r.status, r.count, r.dashboard, r.age]); });
  out.getRange(1, 1, table.length, 5).setValues(table);
  out.setFrozenRows(1);
  // second table: the distinct values of «الحالة النهائية» (the column rejection is read from)
  var ftable = [["الشهر", "الحالة النهائية (كما هي مكتوبة)", "عدد الشحنات", "تُحسب رفض؟", ""]];
  res.finals.forEach(function (f) { ftable.push([f.month, f.finalStatus, f.count, summaryEffectiveStatus_("", f.finalStatus === "(فارغ)" ? "" : f.finalStatus) ? "نعم" : "لا", ""]); });
  out.getRange(1, 7, ftable.length, 5).setValues(ftable);
  var unknown = res.rows.filter(function (r) { return r.dashboard === DASH_KIND_LABELS_AR_.unknown; });
  Logger.log("STATUS NAMES (" + quarter + ") — months: " + res.monthsRead.join(", ") + "\n" +
    res.rows.map(function (r) { return r.month + " | " + r.status + " | " + r.count + " | " + r.dashboard + " | " + r.age; }).join("\n"));
  try { SpreadsheetApp.getUi().alert("تم. افتح تبويب " + STATUS_NAMES_SHEET + " — " + res.rows.length + " صفًا، منها " + unknown.length + " حالة «غير مصنف»."); } catch (e) { /* run from the editor: no UI */ }
  return { success: true, quarter: quarter, months: res.monthsRead, statuses: res.rows.length, unclassified: unknown.length };
}


// ============================================================
// COLUMN PROFILE — بصمة أعمدة الشيت (لمعرفة أي عمود يميّز مرتجع مفتوح/مغلق وغيره)
// ▶ قائمة ARRIVE Dashboard ← "Profile Columns (الأعمدة)" — تكتب تبويب COLUMN_PROFILE في الملف المفتوح
// لأحدث شهر فيه بيانات (أو لشهر تحدده في profileColumns("October")): لكل عمود اسمه وعدد الخانات المعبّأة
// وعدد القيم المختلفة، وإن كانت القيم المختلفة قليلة (≤ 40) تُكتب كلها مع أعدادها.
// ============================================================
var COLUMN_PROFILE_SHEET = "COLUMN_PROFILE";
function profileColumnsData_(values) {
  var headers = values[0], out = [];
  for (var c = 0; c < headers.length; c++) {
    var counts = {}, distinct = 0, filled = 0, overflow = false;
    for (var r = 1; r < values.length; r++) {
      var v = values[r][c];
      if (v === "" || v === null || v === undefined) continue;
      filled++;
      var key = Object.prototype.toString.call(v) === "[object Date]" ? "(تاريخ)" : summaryNormText(v);
      if (!counts.hasOwnProperty(key)) { if (distinct >= 500) { overflow = true; continue; } counts[key] = 0; distinct++; }
      counts[key]++;
    }
    var vals = "";
    if (!overflow && distinct <= 40) {
      vals = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).map(function (k) { return k + " (" + counts[k] + ")"; }).join(" | ");
    }
    out.push([c + 1, String(headers[c]), filled, overflow ? "500+" : distinct, vals]);
  }
  return out;
}
function profileColumns(monthName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), id = ss.getId(), quarter = null;
  for (var q in SPREADSHEET_IDS) { if (SPREADSHEET_IDS[q] === id) quarter = q; }
  if (!quarter) throw new Error("هذا الملف ليس أحد ملفات Q1/Q2/Q3/Q4.");
  var months = MONTH_ORDER.filter(function (mo) { return MONTH_SOURCE[mo] === quarter; }).reverse();
  var picked = null, values = null;
  for (var i = 0; i < months.length; i++) {
    if (monthName && months[i] !== monthName) continue;
    var sh = ss.getSheetByName(months[i]);
    if (sh && sh.getLastRow() >= 2 && sh.getLastColumn() >= 1) { picked = months[i]; values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues(); break; }
  }
  if (!picked) throw new Error("لا يوجد شهر به بيانات" + (monthName ? " باسم " + monthName : "") + " في هذا الملف.");
  var rows = profileColumnsData_(values);
  var out = ss.getSheetByName(COLUMN_PROFILE_SHEET) || ss.insertSheet(COLUMN_PROFILE_SHEET);
  out.clear();
  var table = [["شهر: " + picked, "اسم العمود (Header)", "خانات معبّأة", "عدد القيم المختلفة", "القيم وأعدادها (إن كانت قليلة)"]];
  rows.forEach(function (r) { table.push(r); });
  out.getRange(1, 1, table.length, 5).setValues(table);
  out.setFrozenRows(1);
  try { SpreadsheetApp.getUi().alert("تم. افتح تبويب " + COLUMN_PROFILE_SHEET + " (شهر " + picked + ")."); } catch (e) { /* editor run: no UI */ }
  return { success: true, month: picked, columns: rows.length };
}


// ============================================================
// CLEAR / REBUILD ALL SUMMARIES — حذف كل الملخصات ثم بنائها من جديد
// ▶ 1) "Clear ALL Summaries"  = clearAllSummaries()   : يمسح محتوى تبويبي DASHBOARD_SUMMARY و AGE_SUMMARY في ملفات Q1..Q4
//      (يبقى الصف الأول/العناوين، والشيتات الخام لا تُمس إطلاقًا) ويصفّر تقدم البناء ويُبطل كاش الداشبورد.
// ▶ 2) "Rebuild ALL Summaries" = rebuildAllSummaries() : يبني ملخص الداشبورد + ملخص عمر الشحنة لكل شهر، على دفعات
//      (≈ 4 دقائق للدفعة). شغّلها مرارًا حتى تقول allMonthsComplete: true (تكمل من حيث وقفت).
// الملخصات قابلة لإعادة البناء بالكامل من الشيتات الخام، لذلك الحذف آمن لكن الداشبورد يكون فارغًا حتى تكتمل إعادة البناء.
// ============================================================
function clearAllSummaries() {
  try {
    var ui = SpreadsheetApp.getUi();
    var ans = ui.alert("حذف كل الملخصات", "سيتم مسح ملخصات الداشبورد وعمر الشحنة من ملفات Q1–Q4 (الشيتات الخام لا تتأثر). الداشبورد يبقى فارغًا حتى تعيد البناء. هل تريد المتابعة؟", ui.ButtonSet.YES_NO);
    if (ans !== ui.Button.YES) return { success: false, cancelled: true };
  } catch (e) { /* run from the editor / no UI: proceed — running it is itself the confirmation */ }
  var cleared = [], tabs = [PERSISTENT_SUMMARY_SHEET, AGE_SNAPSHOT_SHEET];
  for (var q in SPREADSHEET_IDS) {
    var ss;
    try { ss = SpreadsheetApp.openById(SPREADSHEET_IDS[q]); }
    catch (err) { cleared.push({ quarter: q, error: "تعذر فتح الملف: " + String(err && err.message ? err.message : err) }); continue; }
    for (var t = 0; t < tabs.length; t++) {
      var sh = ss.getSheetByName(tabs[t]);
      if (!sh) { cleared.push({ quarter: q, tab: tabs[t], rowsDeleted: 0, note: "غير موجود" }); continue; }
      var last = sh.getLastRow(), n = last >= 2 ? last - 1 : 0;
      if (n > 0) sh.deleteRows(2, n);
      cleared.push({ quarter: q, tab: tabs[t], rowsDeleted: n });
    }
  }
  resetSummaryBuildProgress();
  bumpSnapshotGenerationStamp_(); // invalidates every cached dashboard / age-report result
  SpreadsheetApp.flush();
  var res = { success: true, cleared: cleared, next: "شغّل Rebuild ALL Summaries (أكثر من مرة) حتى allMonthsComplete: true" };
  Logger.log(JSON.stringify(res, null, 2));
  try { SpreadsheetApp.getUi().alert("تم حذف كل الملخصات. الآن شغّل «Rebuild ALL Summaries» (كرّرها حتى تكتمل)."); } catch (e2) {}
  return res;
}

// Rebuilds, in resumable batches, the dashboard summary AND the age summary of every month (both are built by
// buildAndSaveMonthSummary). Run it repeatedly: each run continues where the previous one stopped.
function rebuildAllSummaries() {
  var rep = buildNextSummaryBatch();
  var msg = rep.allMonthsComplete
    ? "اكتملت إعادة بناء كل الملخصات ✔"
    : "تم بناء: " + (rep.monthsCompletedThisRun.join("، ") || "—") + " — الشهر التالي: " + rep.nextMonthToProcess + ". شغّل الدالة مرة أخرى.";
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return rep;
}

// ============================================================
// 6. PAGINATED MONTH DATA
// ============================================================

function getMonthPage(sheetName, params) {

  // ----------------------------------------------------------
  // Validate month
  // ----------------------------------------------------------

  if (!MONTH_SOURCE.hasOwnProperty(sheetName)) {

    return {

      success: false,

      error:
        "شهر غير معروف: " +
        sheetName

    };

  }


  var quarter =
    MONTH_SOURCE[sheetName];


  var spreadsheetId =
    SPREADSHEET_IDS[quarter];


  if (!spreadsheetId) {

    return {

      success: false,

      error:
        "Spreadsheet ID غير موجود للمصدر: " +
        quarter

    };

  }


  // ----------------------------------------------------------
  // Pagination parameters
  // ----------------------------------------------------------

  var page =
    parseInt(
      params.page || "1",
      10
    );


  var pageSize =
    parseInt(
      params.pageSize ||
      DEFAULT_PAGE_SIZE,
      10
    );


  if (!isFinite(page) || page < 1) {
    page = 1;
  }


  if (!isFinite(pageSize) || pageSize < 1) {
    pageSize = DEFAULT_PAGE_SIZE;
  }


  if (pageSize > MAX_PAGE_SIZE) {
    pageSize = MAX_PAGE_SIZE;
  }


  // ----------------------------------------------------------
  // Open spreadsheet
  // ----------------------------------------------------------

  var ss;

  try {

    ss =
      SpreadsheetApp.openById(
        spreadsheetId
      );

  }

  catch (err) {

    return {

      success: false,

      error:
        "تعذر فتح Spreadsheet " +
        quarter +
        ": " +
        String(
          err && err.message
            ? err.message
            : err
        )

    };

  }


  // ----------------------------------------------------------
  // Find month tab
  // ----------------------------------------------------------

  var sheet =
    ss.getSheetByName(
      sheetName
    );


  if (!sheet) {

    return {

      success: false,

      error:
        "الشيت غير موجود: " +
        sheetName +
        " داخل " +
        quarter

    };

  }


  // ----------------------------------------------------------
  // Sheet dimensions
  // ----------------------------------------------------------

  var lastRow =
    sheet.getLastRow();

  var lastColumn =
    sheet.getLastColumn();


  if (
    lastRow === 0 ||
    lastColumn === 0
  ) {

    return {

      success: true,

      source: quarter,

      sheet: sheetName,

      page: 1,

      pageSize: pageSize,

      totalRows: 0,

      totalPages: 0,

      hasMore: false,

      empty: true,

      noData: true,

      rows: [[]]

    };

  }


  // ----------------------------------------------------------
  // HEADER
  // ----------------------------------------------------------

  var headers =
    sheet
      .getRange(
        1,
        1,
        1,
        lastColumn
      )
      .getValues()[0];


  // ----------------------------------------------------------
  // Calculate page
  // ----------------------------------------------------------

  var dataRowCount =
    Math.max(
      0,
      lastRow - 1
    );


  var totalPages =
    Math.ceil(
      dataRowCount /
      pageSize
    );


  if (totalPages === 0) {

    return {

      success: true,

      source: quarter,

      sheet: sheetName,

      page: 1,

      pageSize: pageSize,

      totalRows: 0,

      totalPages: 0,

      hasMore: false,

      rows: [headers]

    };

  }


  if (page > totalPages) {

    return {

      success: false,

      error:
        "الصفحة المطلوبة غير موجودة.",

      page: page,

      totalPages: totalPages

    };

  }


  // ----------------------------------------------------------
  // Calculate actual rows
  // ----------------------------------------------------------

  var startDataIndex =
    (page - 1) *
    pageSize;


  var rowsToRead =
    Math.min(
      pageSize,
      dataRowCount -
      startDataIndex
    );


  // Spreadsheet row numbers:
  //
  // Row 1 = header
  // Row 2 = first data row
  //

  var startSheetRow =
    2 +
    startDataIndex;


  // ----------------------------------------------------------
  // Read ONLY current page
  // ----------------------------------------------------------

  var values =
    sheet
      .getRange(
        startSheetRow,
        1,
        rowsToRead,
        lastColumn
      )
      .getValues();


  // ----------------------------------------------------------
  // Convert dates
  // ----------------------------------------------------------

  var timezone =
    Session.getScriptTimeZone() ||
    "Africa/Cairo";


  var convertedRows =
    values.map(function(row) {

      return row.map(function(cell) {

        if (
          Object.prototype.toString.call(cell) ===
          "[object Date]"
        ) {

          return Utilities.formatDate(
            cell,
            timezone,
            "yyyy-MM-dd'T'HH:mm:ss"
          );

        }

        return cell;

      });

    });


  // ----------------------------------------------------------
  // Response
  // ----------------------------------------------------------

  return {

    success: true,

    source: quarter,

    spreadsheetId:
      spreadsheetId,

    sheet:
      sheetName,

    page:
      page,

    pageSize:
      pageSize,

    totalRows:
      dataRowCount,

    totalPages:
      totalPages,

    hasMore:
      page < totalPages,

    startRow:
      startSheetRow,

    endRow:
      startSheetRow +
      rowsToRead -
      1,

    rows:
      [headers].concat(
        convertedRows
      )

  };

}


// ============================================================
// 6A. PERSISTENT COMPACT SUMMARY STORAGE
// ============================================================

function getPersistentSummarySheet_(quarter) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_IDS[quarter]);
  var sh = ss.getSheetByName(PERSISTENT_SUMMARY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PERSISTENT_SUMMARY_SHEET);
    sh.getRange(1,1,1,9).setValues([[
      "Month","Version","Generated At","Total Rows","Grand Total",
      "Chunk Index","Chunk Count","JSON Chunk","Updated By"
    ]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getSavedMonthSummary_(sheetName) {
  if (!MONTH_SOURCE.hasOwnProperty(sheetName)) return null;
  var quarter = MONTH_SOURCE[sheetName];
  var sh = getPersistentSummarySheet_(quarter);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var rows = sh.getRange(2,1,last-1,9).getValues();
  var matches = [];
  for (var i=0;i<rows.length;i++) {
    if (String(rows[i][0] || "").trim() === sheetName &&
        String(rows[i][1] || "") === PERSISTENT_SUMMARY_VERSION) {
      matches.push(rows[i]);
    }
  }
  if (!matches.length) return null;
  matches.sort(function(a,b){ return Number(a[5]) - Number(b[5]); });
  var expected = Number(matches[0][6]) || 0;
  if (!expected || matches.length !== expected) return null;
  var json = "";
  for (var j=0;j<matches.length;j++) {
    if (Number(matches[j][5]) !== j) return null;
    json += String(matches[j][7] || "");
  }
  try {
    var obj = JSON.parse(json);
    obj.success = obj.success !== false;
    obj.persistent = true;
    obj.snapshot = true;
    return obj;
  } catch (err) {
    console.log("[PERSISTENT SUMMARY INVALID] " + sheetName + " " + String(err));
    return null;
  }
}

function saveMonthSummary_(sheetName, summary) {
  var quarter = MONTH_SOURCE[sheetName];
  if (!quarter) throw new Error("شهر غير معروف: " + sheetName);
  var sh = getPersistentSummarySheet_(quarter);
  var json = JSON.stringify(summary);
  var chunks = [];
  for (var i=0;i<json.length;i+=PERSISTENT_SUMMARY_CHUNK_SIZE) {
    chunks.push(json.substring(i, i + PERSISTENT_SUMMARY_CHUNK_SIZE));
  }
  if (!chunks.length) chunks.push("{}");

  var last = sh.getLastRow();
  if (last >= 2) {
    var existing = sh.getRange(2,1,last-1,1).getValues();
    for (var r=existing.length-1;r>=0;r--) {
      if (String(existing[r][0] || "").trim() === sheetName) sh.deleteRow(r+2);
    }
  }

  var who = "";
  try { who = Session.getActiveUser().getEmail() || ""; } catch(e) {}
  var now = new Date().toISOString();
  var values = [];
  for (var c=0;c<chunks.length;c++) {
    values.push([
      sheetName,
      PERSISTENT_SUMMARY_VERSION,
      now,
      Number(summary.totalRows || 0),
      Number(summary.grandTotal || 0),
      c,
      chunks.length,
      chunks[c],
      who
    ]);
  }
  sh.getRange(sh.getLastRow()+1,1,values.length,9).setValues(values);
  SpreadsheetApp.flush();
  console.log("[PERSISTENT SUMMARY SAVED] " + JSON.stringify({month:sheetName,quarter:quarter,chunks:chunks.length,totalRows:summary.totalRows || 0}));
  bumpSnapshotGenerationStamp_(); // invalidate every cached dashboard result (single-month AND All Months) — see Bug #6
  return { success:true, month:sheetName, quarter:quarter, chunks:chunks.length };
}

function buildAndSaveMonthSummary(sheetName) {
  if (!MONTH_SOURCE.hasOwnProperty(sheetName)) {
    return { success:false, error:"شهر غير معروف: " + sheetName };
  }
  var started = new Date().getTime();
  // ROOT CAUSE FIX (Batch 1 follow-up): this used to call getMonthDashboardSummary
  // with NO slaTarget/branchSlaTargets in params at all, so it silently fell back
  // to SUMMARY_DEFAULT_SLA_DAYS (2) and {} (no branch overrides) for EVERY
  // snapshot ever built — regardless of what was configured/persisted in
  // Settings. A snapshot is an admin/build-time artifact with no "current
  // browser session" to inherit settings from, so it must explicitly read the
  // one persisted source of truth (getPersistedSlaSettings_) itself.
  var slaSettings = getPersistedSlaSettings_();
  var params = {
    __buildPersistentSummary: true, refresh: "1",
    slaTarget: slaSettings.slaTargetDefault,
    branchSlaTargets: JSON.stringify(slaSettings.branchSlaTargets)
  };
  var summary = getMonthDashboardSummary(sheetName, params);
  if (!summary || summary.success === false) return summary || {success:false,error:"فشل بناء Summary"};
  summary.persistent = true;
  summary.snapshot = true;
  summary.generatedAt = summary.generatedAt || new Date().toISOString();
  var saved = saveMonthSummary_(sheetName, summary);
  // The shipment-age summary (AGE_SUMMARY) is refreshed together with the main dashboard summary, from the SAME
  // update entry points (menu items, batch builder, ?action=buildSummary), so one update keeps every tab's numbers
  // current. A failure here never fails the main snapshot — it is reported in `ageSnapshot` instead.
  var ageSnapshot = ageSnapshotWithSummary_(sheetName, summary);
  return {
    ageSnapshot: ageSnapshot,
    success:true,
    month:sheetName,
    source:MONTH_SOURCE[sheetName],
    totalRows:Number(summary.totalRows || 0),
    grandTotal:Number(summary.grandTotal || 0),
    empty:!!(summary.empty || summary.noData),
    generatedAt:summary.generatedAt,
    durationMs:new Date().getTime()-started,
    chunks:saved.chunks,
    slaConfigUsed: { slaTargetDefault: slaSettings.slaTargetDefault, branchSlaTargets: slaSettings.branchSlaTargets }
  };
}

function buildQuarterSummaries(quarter) {
  if (!SPREADSHEET_IDS[quarter]) return {success:false,error:"ربع غير معروف: " + quarter};
  var results = [];
  for (var i=0;i<MONTH_ORDER.length;i++) {
    var month = MONTH_ORDER[i];
    if (MONTH_SOURCE[month] !== quarter) continue;
    try { results.push(buildAndSaveMonthSummary(month)); }
    catch(err) { results.push({success:false,month:month,error:String(err && err.message ? err.message : err)}); }
  }
  return {success:true,quarter:quarter,results:results};
}

function buildAllDashboardSummaries() {
  var out = [];
  for (var i=0;i<MONTH_ORDER.length;i++) out.push(buildAndSaveMonthSummary(MONTH_ORDER[i]));
  return {success:true,results:out};
}

// Builds a snapshot ONLY for months that don't already have one usable
// with the plain default build settings (attemptT1=1, attemptT2=2,
// slaTargetDefault, no branch overrides) — the exact same compatibility
// check getAllMonthsDashboardSummary's fast path already applies before
// trusting a snapshot. Reuses buildAndSaveMonthSummary() as-is (the SAME
// architecture already used successfully for January-March) — this
// function only decides WHICH months need it, so already-good snapshots
// (e.g. January-March) are left completely untouched and are not
// re-computed. A month whose sheet is genuinely empty gets a real
// "empty" snapshot saved too (this records the already-correct fact that
// it has no data — see getMonthDashboardSummary's own noData/empty
// detection — it never invents shipment data), which lets a future All
// Months request recognize it as an empty month from the fast snapshot
// path instead of re-reading that (empty) sheet live every time.
function buildMissingMonthSnapshots() {
  var out = [];
  // ROOT CAUSE FIX (Batch 1 follow-up): "compatible" used to mean "matches
  // the hardcoded SUMMARY_DEFAULT_SLA_DAYS/{} literally" — so once real
  // branch SLA overrides are saved in Settings, every existing snapshot
  // (all built at the old 2-day-only default) would be wrongly reported as
  // "already compatible" and skipped, permanently locking in the wrong SLA
  // numbers until this compatibility target changed too. Now compares
  // against the actual persisted configuration instead.
  var persisted = getPersistedSlaSettings_();
  for (var i = 0; i < MONTH_ORDER.length; i++) {
    var month = MONTH_ORDER[i];
    var existing;
    try { existing = getSavedMonthSummary_(month); } catch (eRead) { existing = null; }
    var needsBuild = true;
    var skipReason = null;
    if (existing) {
      if (existing.empty || existing.noData) {
        needsBuild = false; skipReason = "already-empty-snapshot";
      } else {
        var bc = existing.filterCube && existing.filterCube.buildConfig;
        var compatibleWithDefaults = !!bc &&
          Number(bc.attemptT1) === 1 && Number(bc.attemptT2) === 2 &&
          Number(bc.slaTargetDefault) === Number(persisted.slaTargetDefault) &&
          summaryBranchTargetsEqual_(bc.branchSlaTargets, persisted.branchSlaTargets);
        if (compatibleWithDefaults) { needsBuild = false; skipReason = "already-compatible-snapshot"; }
      }
    }
    if (!needsBuild) { out.push({ month: month, skipped: true, reason: skipReason }); continue; }
    try { out.push(buildAndSaveMonthSummary(month)); }
    catch (err) { out.push({ success:false, month: month, error: String(err && err.message ? err.message : err) }); }
  }
  return { success: true, results: out };
}

// ============================================================
// RESUMABLE / CHUNKED SNAPSHOT BATCH BUILD (admin/backend only)
// ============================================================
// Fixes: buildAllDashboardSummaries() loops all 12 MONTH_ORDER months and
// calls buildAndSaveMonthSummary() for every one of them inside a SINGLE
// Apps Script execution. Each month's heavy raw-row aggregation takes
// roughly 20-30s, so 12 months can approach or exceed Apps Script's
// execution time ceiling ("Exceeded maximum execution time"), especially
// on a slower month or with any added overhead.
//
// buildAndSaveMonthSummary()/buildQuarterSummaries()/buildAllDashboardSummaries()
// are all left completely UNCHANGED below -- this is a new, separate,
// opt-in entry point (buildNextSummaryBatch()) that processes only as many
// months as safely fit within one execution's time budget, persists
// exactly which months are already done via PropertiesService, and is
// designed to be run repeatedly (manually, from the Apps Script editor)
// until its report says allMonthsComplete: true. No time-based trigger is
// installed anywhere -- running it again is a manual action, same as
// buildAllDashboardSummaries()/buildMissingMonthSnapshots() already are.
var SNAPSHOT_BUILD_PROGRESS_PROPERTY_KEY = "SNAPSHOT_BUILD_PROGRESS_JSON";
// Safety time budget PER EXECUTION of buildNextSummaryBatch(), checked only
// BETWEEN months (never used to abort a month mid-build) -- comfortably
// below Apps Script's ~6-minute ceiling for a manually-run/simple-trigger
// execution, leaving headroom for the per-month ~20-30s builds already in
// flight plus logging/PropertiesService overhead after the loop ends.
var SNAPSHOT_BUILD_TIME_BUDGET_MS = 240000; // 4 minutes

function getSnapshotBuildProgress_() {
  var fallback = { completed: {}, failed: {}, startedAt: null, lastUpdatedAt: null };
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SNAPSHOT_BUILD_PROGRESS_PROPERTY_KEY);
    if (!raw) return fallback;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    return {
      completed: (parsed.completed && typeof parsed.completed === "object") ? parsed.completed : {},
      failed: (parsed.failed && typeof parsed.failed === "object") ? parsed.failed : {},
      startedAt: parsed.startedAt || null,
      lastUpdatedAt: parsed.lastUpdatedAt || null
    };
  } catch (e) {
    console.log("[SNAPSHOT BUILD PROGRESS READ FAILED] " + String(e && e.message ? e.message : e));
    return fallback;
  }
}

function saveSnapshotBuildProgress_(progress) {
  try {
    PropertiesService.getScriptProperties().setProperty(SNAPSHOT_BUILD_PROGRESS_PROPERTY_KEY, JSON.stringify(progress));
    return true;
  } catch (e) {
    console.log("[SNAPSHOT BUILD PROGRESS SAVE FAILED] " + String(e && e.message ? e.message : e));
    return false;
  }
}

// Intentionally restarts the resumable batch from January — does NOT touch
// any saved DASHBOARD_SUMMARY snapshot, SLA settings, cache, or anything
// else. Only clears buildNextSummaryBatch()'s own progress bookkeeping.
function resetSummaryBuildProgress() {
  try {
    PropertiesService.getScriptProperties().deleteProperty(SNAPSHOT_BUILD_PROGRESS_PROPERTY_KEY);
    var msg = "تم مسح تقدم البناء التراكمي — سيبدأ buildNextSummaryBatch() القادم من " + MONTH_ORDER[0] + ".";
    Logger.log(msg);
    return { success: true, message: msg };
  } catch (e) {
    var errMsg = "فشل مسح تقدم البناء: " + String(e && e.message ? e.message : e);
    Logger.log(errMsg);
    return { success: false, error: errMsg };
  }
}

// A month already marked "completed" by a previous buildNextSummaryBatch()
// run is only actually SKIPPED if its saved snapshot is still compatible
// with the CURRENT persisted SLA settings — the exact same compatibility
// rule buildMissingMonthSnapshots() already applies above. This means
// re-running the batch after changing SLA settings in Settings correctly
// rebuilds every month again instead of trusting a stale "already done"
// flag from before the SLA change. This is a lightweight snapshot-metadata
// read, not a raw-row aggregation, so checking it for every already-
// completed month on every run is cheap.
function snapshotIsCurrentlyCompatible_(month, persistedSla) {
  var existing;
  try { existing = getSavedMonthSummary_(month); } catch (eRead) { existing = null; }
  if (!existing) return false;
  if (existing.empty || existing.noData) return true;
  var bc = existing.filterCube && existing.filterCube.buildConfig;
  return !!bc &&
    Number(bc.attemptT1) === 1 && Number(bc.attemptT2) === 2 &&
    Number(bc.slaTargetDefault) === Number(persistedSla.slaTargetDefault) &&
    summaryBranchTargetsEqual_(bc.branchSlaTargets, persistedSla.branchSlaTargets);
}

// THE function to run repeatedly (manually, from the Apps Script editor)
// until the returned/logged report says allMonthsComplete: true. Safe to
// run as many times as needed; already-completed+compatible months are
// never rebuilt.
function buildNextSummaryBatch() {
  var started = new Date().getTime();
  var progress = getSnapshotBuildProgress_();
  if (!progress.startedAt) progress.startedAt = new Date().toISOString();

  var persistedSla = getPersistedSlaSettings_();

  var attempted = [], completedThisRun = [], skipped = [], failed = [];
  // Caches each month's compatibility result the moment it's actually
  // computed (in the skip-check below, or implicitly known after a fresh
  // build this run), so the final completion scan can reuse it instead of
  // blindly recomputing snapshotIsCurrentlyCompatible_ for every month a
  // second time — while still always computing it fresh for any month the
  // main loop never reached this run (e.g. after an early budget stop).
  var compatCache = {};

  for (var i = 0; i < MONTH_ORDER.length; i++) {
    var month = MONTH_ORDER[i];

    if (progress.completed.hasOwnProperty(month)) {
      var isCompatNow = snapshotIsCurrentlyCompatible_(month, persistedSla);
      compatCache[month] = isCompatNow;
      if (isCompatNow) {
        skipped.push(month);
        continue;
      }
    }

    // Checked BETWEEN months only — never aborts a month already in
    // progress. Once the budget is spent, stop starting new months and let
    // the next manual run pick up from here.
    var elapsed = new Date().getTime() - started;
    if (elapsed > SNAPSHOT_BUILD_TIME_BUDGET_MS) break;

    attempted.push(month);
    try {
      var result = buildAndSaveMonthSummary(month); // UNCHANGED — same getPersistedSlaSettings_ -> getMonthDashboardSummary -> saveMonthSummary_ -> bumpSnapshotGenerationStamp_ chain as every other caller
      if (result && result.success) {
        progress.completed[month] = {
          generatedAt: result.generatedAt, totalRows: result.totalRows,
          grandTotal: result.grandTotal, durationMs: result.durationMs
        };
        if (progress.failed.hasOwnProperty(month)) delete progress.failed[month];
        completedThisRun.push(month);
        compatCache[month] = true; // just built against persistedSla — compatible with it by construction
      } else {
        var errMsg = (result && result.error) ? result.error : "فشل غير معروف (buildAndSaveMonthSummary أعاد success:false بدون رسالة خطأ)";
        progress.failed[month] = { error: errMsg, attemptedAt: new Date().toISOString() };
        failed.push({ month: month, error: errMsg });
      }
    } catch (err) {
      var errMsg2 = String(err && err.message ? err.message : err);
      progress.failed[month] = { error: errMsg2, attemptedAt: new Date().toISOString() };
      failed.push({ month: month, error: errMsg2 });
    }
    // Persisted after EVERY month, not just at the end of the loop — so a
    // failure on a later month, or the execution simply being killed by
    // the platform, can never lose progress already made this run.
    progress.lastUpdatedAt = new Date().toISOString();
    saveSnapshotBuildProgress_(progress);
  }

  // BUG FIX: a month must only count as complete when it is BOTH recorded
  // in progress.completed AND its saved snapshot is STILL compatible with
  // the current persisted SLA — not the completed flag alone. Without the
  // compatibility check here, a full SLA-driven rebuild that gets cut short
  // by the time budget could wrongly report allMonthsComplete: true (every
  // month is still sitting in progress.completed from BEFORE the SLA
  // change, even though most of those saved snapshots are now stale).
  // Reuses compatCache wherever the main loop above already computed it;
  // only recomputes for a month the loop never reached this run (e.g. after
  // an early budget stop) — never for one already known incompatible/absent.
  var nextMonth = null;
  var allMonthsComplete = true;
  for (var j = 0; j < MONTH_ORDER.length; j++) {
    var mj = MONTH_ORDER[j];
    var isCompletedFlag = progress.completed.hasOwnProperty(mj);
    var isCompatibleNow = false;
    if (isCompletedFlag) {
      isCompatibleNow = compatCache.hasOwnProperty(mj) ? compatCache[mj] : snapshotIsCurrentlyCompatible_(mj, persistedSla);
    }
    if (!isCompatibleNow) { nextMonth = mj; allMonthsComplete = false; break; }
  }
  var completedMonths = Object.keys(progress.completed);

  var report = {
    success: true,
    monthsAttempted: attempted,
    monthsCompletedThisRun: completedThisRun,
    monthsSkipped: skipped,
    monthsFailed: failed,
    totalCompletedSoFar: completedMonths,
    totalCompletedCount: completedMonths.length,
    nextMonthToProcess: nextMonth,
    allMonthsComplete: allMonthsComplete,
    durationMs: new Date().getTime() - started
  };

  Logger.log(
    "========================================================\n" +
    "SNAPSHOT BATCH BUILD RUN\n" +
    "========================================================\n" +
    "Months attempted this run: " + (attempted.join(", ") || "(none)") + "\n" +
    "Months completed this run: " + (completedThisRun.join(", ") || "(none)") + "\n" +
    "Months skipped (already complete & compatible): " + (skipped.join(", ") || "(none)") + "\n" +
    "Months failed this run: " + (failed.length ? failed.map(function (f) { return f.month + " (" + f.error + ")"; }).join(", ") : "(none)") + "\n" +
    "Total completed so far (" + completedMonths.length + "/" + MONTH_ORDER.length + "): " + (completedMonths.join(", ") || "(none)") + "\n" +
    "Next month to process: " + (nextMonth || "(none — ALL MONTHS COMPLETE)") + "\n" +
    "All months complete: " + allMonthsComplete + "\n" +
    "Duration: " + report.durationMs + "ms\n" +
    "========================================================"
  );

  return report;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("ARRIVE Dashboard")
    .addItem("Update Current Quarter Summaries", "updateCurrentQuarterSummaries")
    .addItem("Update All 12 Month Summaries", "buildAllDashboardSummaries")
    .addItem("Build Missing Month Snapshots Only", "buildMissingMonthSnapshots")
    .addItem("Build Next Snapshot Batch (resumable)", "buildNextSummaryBatch")
    .addItem("Age Report: Update Current Quarter Summary", "updateCurrentQuarterAgeSnapshots")
    .addItem("Age Report: Build Missing Months Summary", "buildMissingAgeSnapshots")
    .addItem("Age Report: Update All Months Summary", "buildAllAgeSnapshots")
    .addItem("List Status Names (أسماء الحالات)", "listStatusNames")
    .addItem("Profile Columns (الأعمدة)", "profileColumns")
    .addItem("Reset Snapshot Batch Progress", "resetSummaryBuildProgress")
    .addSeparator()
    .addItem("⚠ Clear ALL Summaries (حذف كل الملخصات)", "clearAllSummaries")
    .addItem("Rebuild ALL Summaries (إعادة بناء الكل — كرّرها)", "rebuildAllSummaries")
    .addToUi();
}

function updateCurrentQuarterSummaries() {
  var activeId = SpreadsheetApp.getActiveSpreadsheet().getId();
  for (var q in SPREADSHEET_IDS) {
    if (SPREADSHEET_IDS[q] === activeId) return buildQuarterSummaries(q);
  }
  throw new Error("هذا الملف ليس أحد ملفات Q1/Q2/Q3/Q4.");
}


// ============================================================
// 7. LIST ALL MONTHS
// ============================================================

function listSheetsPayload() {

  var listCache = CacheService.getScriptCache();
  var listCacheKey = "list_sheets_v1";
  var cachedList = listCache.get(listCacheKey);
  if (cachedList) {
    try {
      var parsedList = JSON.parse(cachedList);
      parsedList.cached = true;
      return parsedList;
    } catch (eList) { /* corrupted cache entry — fall through and recompute */ }
  }

  // CONCURRENCY GUARD (see docs/audit.md — Bug #3): without this, every
  // request that lands while the cache is cold (right after the 10-minute
  // TTL expires, or several people opening the dashboard around the same
  // moment) independently opens all 4 Q1-Q4 spreadsheets in parallel,
  // multiplying load on Google Sheets exactly when it is already slowest —
  // a direct contributor to the >30s client-side listSheets timeout. A
  // short script lock serializes the (rare) cold-cache computation: only
  // the first request actually rebuilds the list; every other concurrent
  // request waits briefly, then re-checks the cache (now populated by
  // whichever request got there first) instead of redoing the same work.
  var lock = LockService.getScriptLock();
  var haveLock = false;
  try {
    haveLock = lock.tryLock(20000); // wait up to 20s — stays comfortably under the frontend's 30s listSheets timeout
  } catch (eLock) {
    haveLock = false; // LockService itself failing must never block listSheets entirely — fall through and compute directly
  }

  try {
    // Another request may have finished building + caching the list while
    // we were waiting for the lock — use that instead of recomputing.
    var cachedAfterLock = listCache.get(listCacheKey);
    if (cachedAfterLock) {
      try {
        var parsedAfterLock = JSON.parse(cachedAfterLock);
        parsedAfterLock.cached = true;
        return parsedAfterLock;
      } catch (eList2) { /* corrupted — fall through and recompute below */ }
    }
    return buildSheetsListAndCache_(listCache, listCacheKey);
  } finally {
    if (haveLock) {
      try { lock.releaseLock(); } catch (eRelease) { /* non-fatal */ }
    }
  }
}

// Does the actual 4-spreadsheet scan, builds the result, and writes it to
// CacheService. Split out of listSheetsPayload() only so the lock/re-check
// logic above has one place to call — the scan itself is byte-for-byte
// identical to before this change.
function buildSheetsListAndCache_(listCache, listCacheKey) {

  var allMonths = [];

  var sources = {};


  var quarters = [
    "Q1",
    "Q2",
    "Q3",
    "Q4"
  ];


  for (
    var i = 0;
    i < quarters.length;
    i++
  ) {

    var quarter =
      quarters[i];

    var spreadsheetId =
      SPREADSHEET_IDS[quarter];


    sources[quarter] = {

      status: "UNKNOWN",

      spreadsheetId:
        spreadsheetId,

      months: []

    };


    try {

      var ss =
        SpreadsheetApp.openById(
          spreadsheetId
        );


      var tabs =
        ss.getSheets();


      var foundMonths = [];


      for (
        var j = 0;
        j < tabs.length;
        j++
      ) {

        var name =
          tabs[j].getName();


        if (
          MONTH_SOURCE.hasOwnProperty(name) &&
          MONTH_SOURCE[name] === quarter
        ) {

          foundMonths.push(name);

          allMonths.push(name);

        }

      }


      sources[quarter].status =
        "OK";

      sources[quarter].months =
        foundMonths;

    }

    catch (err) {

      sources[quarter].status =
        "ERROR";

      sources[quarter].error =
        String(
          err && err.message
            ? err.message
            : err
        );

    }

  }


  allMonths.sort(function(a, b) {

    return (
      MONTH_ORDER.indexOf(a) -
      MONTH_ORDER.indexOf(b)
    );

  });


  var listResult = {

    success: true,

    sheets:
      allMonths,

    sources:
      sources,

    expectedMonths:
      MONTH_ORDER,

    cached: false

  };

  try {
    var serializedList = JSON.stringify(listResult);
    if (serializedList.length < 100000) listCache.put(listCacheKey, serializedList, LIST_SHEETS_CACHE_TTL_SECONDS);
  } catch (eListCache) { /* non-fatal — caching is a performance optimization, not a requirement */ }

  return listResult;

}


// ============================================================
// 8. DIAGNOSTIC
// ============================================================

function diagnoseMonth(sheetName) {

  if (!sheetName) {

    return {

      success: false,

      error:
        "استخدم ?action=diagnose&sheet=July"

    };

  }


  if (
    !MONTH_SOURCE.hasOwnProperty(
      sheetName
    )
  ) {

    return {

      success: false,

      error:
        "الشهر غير معروف: " +
        sheetName

    };

  }


  var quarter =
    MONTH_SOURCE[sheetName];


  var spreadsheetId =
    SPREADSHEET_IDS[quarter];


  var result = {

    success: false,

    sheet:
      sheetName,

    source:
      quarter,

    spreadsheetId:
      spreadsheetId,

    spreadsheetOpened:
      false,

    sheetFound:
      false,

    rowCount:
      0,

    columnCount:
      0,

    headers:
      [],

    // Answers section 2 of the audit request directly: does this month
    // have a saved snapshot at all, is it empty, and is it built with the
    // CURRENT PERSISTED SLA settings (Batch 1 follow-up fix — this used to
    // compare against the hardcoded SUMMARY_DEFAULT_SLA_DAYS/{} literal,
    // which would falsely report a correctly-rebuilt snapshot as
    // "incompatible" once real branch SLA overrides are saved) — without
    // running a full live aggregation just to find out.
    snapshot: (function(){
      var snap = null;
      try { snap = getSavedMonthSummary_(sheetName); } catch (eSnap) { return { exists:false, error:String(eSnap && eSnap.message ? eSnap.message : eSnap) }; }
      if (!snap) return { exists:false };
      if (snap.empty || snap.noData) return { exists:true, empty:true, generatedAt: snap.generatedAt || null };
      var bc = snap.filterCube && snap.filterCube.buildConfig;
      var persistedForDiag = getPersistedSlaSettings_();
      var compatibleWithDefaults = !!bc &&
        Number(bc.attemptT1) === 1 && Number(bc.attemptT2) === 2 &&
        Number(bc.slaTargetDefault) === Number(persistedForDiag.slaTargetDefault) &&
        summaryBranchTargetsEqual_(bc.branchSlaTargets, persistedForDiag.branchSlaTargets);
      return {
        exists:true, empty:false, compatibleWithDefaults: compatibleWithDefaults, buildConfig: bc || null,
        currentPersistedSlaSettings: persistedForDiag,
        generatedAt: snap.generatedAt || null, totalRows: snap.totalRows || 0,
        total: snap.kpis ? snap.kpis.total : null, delivered: snap.kpis ? snap.kpis.delivered : null,
        deliveryRate: snap.kpis ? snap.kpis.deliveryRate : null
      };
    })(),

    // Answers "would a normal (unfiltered) request right now use the
    // snapshot or fall back to live aggregation, and why" — the exact same
    // decision getAllMonthsDashboardSummary's fast path makes, now checked
    // against the CURRENT PERSISTED SLA settings (same follow-up fix as
    // above). When there is no compatible snapshot, this ACTUALLY runs the
    // same live aggregation All Months would run (getMonthDashboardSummary),
    // rather than guessing — a genuine answer, not a prediction.
    allMonths: (function(){
      var snap2 = null;
      try { snap2 = getSavedMonthSummary_(sheetName); } catch (eSnap2) { snap2 = null; }
      if (snap2 && (snap2.empty || snap2.noData)) {
        return { included:false, asEmptyMonth:true, reason:"Snapshot marks this month as empty — correctly excluded from totals as an EMPTY month, not a failure." };
      }
      if (snap2) {
        var bc2 = snap2.filterCube && snap2.filterCube.buildConfig;
        var persistedForDiag2 = getPersistedSlaSettings_();
        var compatible2 = !!bc2 &&
          Number(bc2.attemptT1) === 1 && Number(bc2.attemptT2) === 2 &&
          Number(bc2.slaTargetDefault) === Number(persistedForDiag2.slaTargetDefault) &&
          summaryBranchTargetsEqual_(bc2.branchSlaTargets, persistedForDiag2.branchSlaTargets);
        if (compatible2) {
          return {
            included:true, source:"snapshot",
            total: snap2.kpis ? snap2.kpis.total : null, delivered: snap2.kpis ? snap2.kpis.delivered : null,
            deliveryRate: snap2.kpis ? snap2.kpis.deliveryRate : null
          };
        }
      }
      // No usable snapshot — actually run the same live fallback All Months would.
      try {
        var liveResult = getMonthDashboardSummary(sheetName, { __requestId: "diagnose-" + sheetName });
        if (!liveResult || liveResult.success === false) {
          return { included:false, reason:"Live fallback FAILED: " + (liveResult && liveResult.error ? liveResult.error : "unknown error") };
        }
        if (liveResult.empty || liveResult.noData) {
          return { included:false, asEmptyMonth:true, reason:"Live computation shows this month genuinely has zero rows — an EMPTY month, not a failure." };
        }
        return {
          included:true, source:"live-fallback",
          total: liveResult.kpis ? liveResult.kpis.total : null, delivered: liveResult.kpis ? liveResult.kpis.delivered : null,
          deliveryRate: liveResult.kpis ? liveResult.kpis.deliveryRate : null
        };
      } catch (eLive) {
        return { included:false, reason:"Live fallback threw an exception: " + String(eLive && eLive.message ? eLive.message : eLive) };
      }
    })()

  };


  var start =
    new Date().getTime();


  try {

    var ss =
      SpreadsheetApp.openById(
        spreadsheetId
      );


    result.spreadsheetOpened =
      true;


    var sheet =
      ss.getSheetByName(
        sheetName
      );


    if (!sheet) {

      result.error =
        "الشيت غير موجود";

      return result;

    }


    result.sheetFound =
      true;


    result.rowCount =
      sheet.getLastRow();


    result.columnCount =
      sheet.getLastColumn();


    if (
      result.rowCount > 0 &&
      result.columnCount > 0
    ) {

      result.headers =
        sheet
          .getRange(
            1,
            1,
            1,
            result.columnCount
          )
          .getValues()[0];

    }


    result.elapsedMs =
      new Date().getTime() -
      start;


    result.success =
      true;


    return result;

  }

  catch (err) {

    result.error =
      String(
        err && err.message
          ? err.message
          : err
      );


    result.elapsedMs =
      new Date().getTime() -
      start;


    return result;

  }

}


// STATUS CLASSIFICATION DIAGNOSTIC (see docs/production-debug-fixes.md —
// Bug #10 investigation). Deliberately general — takes sheetName as a
// parameter and contains NO month-specific branching — so it works
// identically for June, May, July, or any other month; diagnoseJuneStatuses()
// below is only a thin convenience alias with the exact name requested,
// NOT a separate code path.
//
// Opens the sheet with the EXACT same read (SpreadsheetApp.openById ->
// getSheetByName -> one getRange().getValues() call) and column-detection
// (summaryDetectColumnMap) that getMonthDashboardSummary itself uses, so
// this diagnostic can never see a different status column or different
// raw values than what the real aggregation sees.
function diagnoseStatusBreakdown(sheetName) {
  if (!sheetName) return { success: false, error: "sheetName مطلوب" };
  if (!MONTH_SOURCE.hasOwnProperty(sheetName)) return { success: false, error: "شهر غير معروف: " + sheetName };

  var quarter = MONTH_SOURCE[sheetName];
  var spreadsheetId = SPREADSHEET_IDS[quarter];
  var ss;
  try { ss = SpreadsheetApp.openById(spreadsheetId); }
  catch (err) { return { success: false, error: "تعذر فتح Spreadsheet " + quarter + ": " + String(err && err.message ? err.message : err) }; }

  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { success: false, error: "الشيت غير موجود: " + sheetName + " داخل " + quarter };

  var lastRow = sheet.getLastRow(), lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn === 0) return { success: true, sheet: sheetName, empty: true, note: "لا توجد بيانات في هذا الشيت." };

  var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var headers = values[0];
  var dataRows = values.slice(1);

  var colMap = summaryDetectColumnMap(headers);
  var statusColIdx = headers.indexOf(colMap.status);

  var result = {
    success: true,
    sheet: sheetName,
    source: quarter,
    // "اسم عمود الـ Status الذي تم اكتشافه" — النص الحرفي للـ Header المطابق،
    // وموقعه (1-based، كما يظهر في الشيت فعلياً)، أو null إن لم يُكتشف إطلاقاً
    // (وهذا بحد ذاته سيكون هو الـ Root Cause الأوضح لو حدث).
    detectedStatusColumnHeader: colMap.status || null,
    detectedStatusColumnIndex1Based: statusColIdx >= 0 ? (statusColIdx + 1) : null,
    allHeaders: headers,
    totalRows: dataRows.length
  };
  if (statusColIdx < 0) {
    result.rootCauseHint = "لم يتم اكتشاف عمود الحالة إطلاقاً — أي Header في allHeaders أعلاه لم يطابق أياً من الأسماء المعروفة لعمود status. هذا يفسر مباشرة كل الصفوف كـ Unknown.";
    return result;
  }

  // RAW STATUS VALUES — القيمة الحقيقية تماماً كما هي في الخلية (قبل أي
  // Normalization)، مع نوع القيمة (typeof) لأن قيمة من نوع Date أو Number
  // بدل String تكشف عادة مشكلة إزاحة أعمدة (Column Shift)، وليس مجرد فرق
  // إملائي.
  var rawCounts = {}; // exact original cell text -> count
  var rawTypeExamples = {}; // exact original cell text -> typeof + sample
  var normalizedCounts = {}; // after summaryNormText + summaryNormalizeArabicForMatch_ -> count
  var bucketCounts = { delivered:0, returned:0, rejected:0, pending:0, unknown:0 };
  var unknownRawBreakdown = {}; // raw text -> count, ONLY for rows that end up unknown

  for (var i = 0; i < dataRows.length; i++) {
    var rawVal = dataRows[i][statusColIdx];
    var rawKey = (rawVal === null || rawVal === undefined) ? "(فارغ/null)" : String(rawVal);
    rawCounts[rawKey] = (rawCounts[rawKey]||0) + 1;
    if (!rawTypeExamples[rawKey]) rawTypeExamples[rawKey] = typeof rawVal + (rawVal instanceof Date ? " (Date object!)" : "");

    var trimmed = summaryNormText(rawVal);
    var normKey = summaryNormalizeArabicForMatch_(trimmed);
    normalizedCounts[normKey || "(فارغ بعد التنظيف)"] = (normalizedCounts[normKey || "(فارغ بعد التنظيف)"]||0) + 1;

    var bucket = summaryClassifyStatus(rawVal);
    bucketCounts[bucket] = (bucketCounts[bucket]||0) + 1;
    if (bucket === "unknown") {
      unknownRawBreakdown[rawKey] = (unknownRawBreakdown[rawKey]||0) + 1;
    }
  }

  function toSortedArray(countsObj) {
    var out = [];
    for (var k in countsObj) { if (countsObj.hasOwnProperty(k)) out.push({ value: k, count: countsObj[k] }); }
    out.sort(function (a, b) { return b.count - a.count; });
    return out;
  }

  result.rawStatusValues = toSortedArray(rawCounts).map(function (r) {
    return { value: r.value, count: r.count, typeofValue: rawTypeExamples[r.value] };
  });
  result.normalizedStatusValues = toSortedArray(normalizedCounts);
  result.classifiedBuckets = bucketCounts;
  // "أمثلة من القيم التي انتهت Unknown" — القيم الخام الحقيقية بالضبط، مرتبة
  // تنازلياً حسب العدد، فأكبر مساهم في Unknown يظهر أولاً.
  result.unknownRawValues = toSortedArray(unknownRawBreakdown);
  result.currentStatusMap = SUMMARY_STATUS_MAP; // نفس الخريطة الفعلية المُستخدَمة الآن، للمقارنة المباشرة
  // "سبب عدم تصنيف كل Status رئيسي بشكل صحيح" — تفسير مباشر لكل قيمة غير
  // مصنفة: هل هي قريبة (بعد التطبيع) من قيمة مُدرجة في الخريطة فعلاً (فرق
  // إملائي بسيط لم يلتقطه التطبيع الحالي) أم مختلفة تماماً؟
  var mappedNormalizedValues = {};
  for (var bkt in SUMMARY_STATUS_MAP) {
    for (var v = 0; v < SUMMARY_STATUS_MAP[bkt].length; v++) {
      mappedNormalizedValues[summaryNormalizeArabicForMatch_(summaryNormText(SUMMARY_STATUS_MAP[bkt][v]))] = bkt;
    }
  }
  result.unknownRawValues.forEach(function (u) {
    var normOfUnknown = summaryNormalizeArabicForMatch_(summaryNormText(u.value));
    u.normalizedForm = normOfUnknown;
    u.exactlyMatchesAnyMappedBucket = mappedNormalizedValues.hasOwnProperty(normOfUnknown); // should always be false here by construction — sanity check
  });

  return result;
}

// Exact name requested — a thin, zero-logic alias. All real logic lives in
// the general diagnoseStatusBreakdown() above (no June-specific branching
// anywhere in this file).
function diagnoseJuneStatuses() {
  return diagnoseStatusBreakdown("June");
}

// ============================================================
// 9. JSON RESPONSE

function jsonResponse(obj) {

  return ContentService

    .createTextOutput(
      JSON.stringify(obj)
    )

    .setMimeType(
      ContentService.MimeType.TEXT
    );

}
function buildMissingSummaries() {
  const result = buildMissingMonthSnapshots();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function rebuildRemainingMonths() {
  const months = ['June', 'July', 'August'];

  months.forEach(function(month) {
    Logger.log('Building: ' + month);

    const result = buildAndSaveMonthSummary(month);

    Logger.log(JSON.stringify({
      month: month,
      result: result
    }, null, 2));
  });
}