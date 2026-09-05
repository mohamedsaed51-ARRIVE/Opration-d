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

    // --------------------------------------------------------
    // DIAGNOSTIC
    // --------------------------------------------------------

    else if (action === "diagnose") {
      result = diagnoseMonth(sheetName);
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
  lastStatus:  ["تاريخ اخر حالة", "تاريخ آخر حالة", "Last Status Date"],
  cod:         ["مبلغ التحصيل", "COD"],
  shipCost:    ["تكلفة الشحن", "Shipping Cost"]
};

var SUMMARY_STATUS_MAP = {
  delivered: ["تسليم ناجح"],
  returned:  ["مرتجعات"],
  rejected:  ["رفض الاستلام و تم دفع الشحن", "رفض الاستلام و رفض والدفع"],
  pending:   ["قيد التشغيل", "قيد  التشغيل"]
};

var SUMMARY_DEFAULT_SLA_DAYS = 2;

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
function summaryBuildStatusLookup() {
  var lookup = {};
  var buckets = Object.keys(SUMMARY_STATUS_MAP);
  for (var i = 0; i < buckets.length; i++) {
    var vals = SUMMARY_STATUS_MAP[buckets[i]];
    for (var v = 0; v < vals.length; v++) {
      lookup[summaryNormText(vals[v])] = buckets[i];
    }
  }
  return lookup;
}
function summaryClassifyStatus(status) {
  if (!SUMMARY_STATUS_LOOKUP) SUMMARY_STATUS_LOOKUP = summaryBuildStatusLookup();
  var n = summaryNormText(status);
  return SUMMARY_STATUS_LOOKUP.hasOwnProperty(n) ? SUMMARY_STATUS_LOOKUP[n] : "unknown";
}

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
      successRate: k.successRate, avgDays: k.avgDays, withinSla: k.withinSla, slaBreach: k.slaBreach, slaPct: k.slaAchievement
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
  return filters;
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
  return { total: 0, delivered: 0, returned: 0, rejected: 0, pending: 0, unknown: 0,
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
  } else if (r.bucket === "returned") { acc.returned++; }
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
    successRate: successRate, avgDays: avgDays, withinSla: acc.withinSla, slaBreach: acc.slaBreach, slaPct: slaAchievement
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
function summaryAccumulateCubeRecord_(acc, rec, bucket) {
  var n = rec[7];
  acc.total += n;
  if (bucket === "delivered") {
    acc.delivered += n;
    acc.deliveredWithDate += rec[11];
    acc.sumSlaDays += rec[10];
    acc.withinSla += rec[8];
    acc.slaBreach += rec[9];
  } else if (bucket === "returned") { acc.returned += n; }
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
      var bucket = summaryClassifyStatus(status);
      var branchName = dict.branch[rec[2]], clientName = dict.client[rec[3]],
        provinceName = dict.province[rec[0]], areaName = dict.area[rec[1]];

      summaryAccumulateCubeRecord_(topAcc, rec, bucket);
      if (bucket === "delivered" && (rec[8] + rec[9]) > 0 && (topMaxDays === null || rec[12] > topMaxDays)) topMaxDays = rec[12];

      summaryAccumulateCubeRecord_(ensureAcc(branchAccMap, branchOrder, branchName), rec, bucket);
      summaryAccumulateCubeRecord_(ensureAcc(customerAccMap, customerOrder, clientName), rec, bucket);
      summaryAccumulateCubeRecord_(ensureAcc(provinceAccMap, provinceOrder, provinceName), rec, bucket);
      summaryAccumulateCubeRecord_(ensureAcc(areaAccMap, areaOrder, areaName), rec, bucket);

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
    total: topAcc.total, delivered: topAcc.delivered, returned: topAcc.returned, rejected: topAcc.rejected,
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
  try { return JSON.stringify(a || {}) === JSON.stringify(b || {}); } catch (e) { return false; }
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
  }) || !!(params && (params.dateFrom || params.dateTo || params.branch));

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
  var cacheKey = "dash_v3_" + sheetName + "_p_" + summaryHashKey(
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
    return { success: true, sheet: sheetName, source: quarter, empty: true, noData: true, totalRows: 0, grandTotal: 0, attemptSummary: { first:0, second:0, other:0, na:0, total:0 }, timeSeries: { daily:[], weekly:[], monthly:[] }, dataQuality: { totalRows:0, distinctAwb:0, dupAwbCount:0, invalidDates:0, missingBranch:0, missingClient:0, missingProvince:0, unknownStatusCount:0, unknownStatusList:[], negativeCod:0, duplicateRecords:[], duplicateRecordsTruncated:false }, facets: { provinces:[], branches:[], clients:[], statuses:[], areasAll:[], areasByProvince:{} }, colMap: {}, generatedAt: new Date().toISOString() };
  }
  if (lastRow < 2) {
    return { success: true, sheet: sheetName, source: quarter, empty: true, noData: true, totalRows: 0, grandTotal: 0, attemptSummary: { first:0, second:0, other:0, na:0, total:0 }, timeSeries: { daily:[], weekly:[], monthly:[] }, dataQuality: { totalRows:0, distinctAwb:0, dupAwbCount:0, invalidDates:0, missingBranch:0, missingClient:0, missingProvince:0, unknownStatusCount:0, unknownStatusList:[], negativeCod:0, duplicateRecords:[], duplicateRecordsTruncated:false }, facets: { provinces:[], branches:[], clients:[], statuses:[], areasAll:[], areasByProvince:{} }, colMap: {}, generatedAt: new Date().toISOString() };
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
    return { success: true, sheet: sheetName, source: quarter, empty: true, noData: true, totalRows: 0, grandTotal: 0, attemptSummary: { first:0, second:0, other:0, na:0, total:0 }, timeSeries: { daily:[], weekly:[], monthly:[] }, dataQuality: { totalRows:0, distinctAwb:0, dupAwbCount:0, invalidDates:0, missingBranch:0, missingClient:0, missingProvince:0, unknownStatusCount:0, unknownStatusList:[], negativeCod:0, duplicateRecords:[], duplicateRecordsTruncated:false }, facets: { provinces:[], branches:[], clients:[], statuses:[], areasAll:[], areasByProvince:{} }, colMap: {}, generatedAt: new Date().toISOString() };
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
  var dqTotalRows = 0, missingBranch = 0, missingClient = 0, missingProvince = 0, negativeCod = 0, unknownStatusCount = 0;
  var unknownStatusSet = {};
  var seenAwbCount = {}; // awb -> occurrence count

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
    if (summaryRowIsAllEmpty(row)) continue;

    var awb = summaryNormText(summaryGetField(row, idx, "awb"));
    if (!awb) continue;

    dqTotalRows++;
    seenAwbCount[awb] = (seenAwbCount[awb] || 0) + 1;

    var pickup = summaryParseDate(summaryGetField(row, idx, "pickup"));
    var lastStatus = summaryParseDate(summaryGetField(row, idx, "lastStatus"));
    if (!pickup) invalidDates++;

    var status = summaryNormText(summaryGetField(row, idx, "status"));
    var bucket = summaryClassifyStatus(status);
    if (bucket === "unknown" && status) { unknownStatusSet[status] = true; unknownStatusCount++; }
    var branch = summaryNormText(summaryGetField(row, idx, "branch"));
    if (!branch) missingBranch++;
    var client = summaryNormText(summaryGetField(row, idx, "client"));
    if (!client) missingClient++;
    var province = summaryNormText(summaryGetField(row, idx, "province"));
    if (!province) missingProvince++;
    var area = summaryNormText(summaryGetField(row, idx, "area"));
    var finalStatus = summaryNormText(summaryGetField(row, idx, "finalStatus"));
    var cod = parseFloat(summaryGetField(row, idx, "cod")) || 0;
    if (cod < 0) negativeCod++;
    var shipCost = parseFloat(summaryGetField(row, idx, "shipCost")) || 0;

    var slaDays = null;
    if (pickup && lastStatus) slaDays = (lastStatus.getTime() - pickup.getTime()) / 86400000;
    var attemptCat = summaryClassifyAttempt(slaDays, attemptT1, attemptT2);

    var rec = {
      awb: awb, client: client, province: province, area: area, branch: branch,
      status: status, bucket: bucket, finalStatus: finalStatus,
      pickup: pickup, lastStatus: lastStatus, slaDays: slaDays, cod: cod, shipCost: shipCost,
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

  var dataQuality = {
    totalRows: dqTotalRows,
    distinctAwb: Object.keys(seenAwbCount).length,
    dupAwbCount: dupCount > 0 ? (function () { var c = 0; for (var k in seenAwbCount) { if (seenAwbCount.hasOwnProperty(k) && seenAwbCount[k] > 1) c++; } return c; })() : 0,
    invalidDates: invalidDates,
    missingBranch: missingBranch,
    missingClient: missingClient,
    missingProvince: missingProvince,
    unknownStatusCount: unknownStatusCount,
    unknownStatusList: summaryObjKeysSorted(unknownStatusSet),
    negativeCod: negativeCod,
    duplicateRecords: duplicateRecords,
    duplicateRecordsTruncated: duplicateRecordsTruncated
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
      var cubeDayKey = pr.pickup ? Utilities.formatDate(pr.pickup, tz, "yyyy-MM-dd") : "";
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
      var dayKey = Utilities.formatDate(pr.pickup, tz, "yyyy-MM-dd");
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
    total: topAcc.total, delivered: topAcc.delivered, returned: topAcc.returned, rejected: topAcc.rejected,
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
  var acc = { total:0, delivered:0, returned:0, rejected:0, pending:0, unknown:0, withinSla:0, slaBreach:0, deliveredWithDate:0, sumSlaDaysWeighted:0 };
  var maxDays = null;
  for (var i = 0; i < kpisList.length; i++) {
    var k = kpisList[i]; if (!k) continue;
    acc.total += k.total||0; acc.delivered += k.delivered||0; acc.returned += k.returned||0;
    acc.rejected += k.rejected||0; acc.pending += k.pending||0; acc.unknown += k.unknown||0;
    acc.withinSla += k.withinSla||0; acc.slaBreach += k.slaBreach||0; acc.deliveredWithDate += k.deliveredWithDate||0;
    acc.sumSlaDaysWeighted += (k.avgDays||0) * (k.deliveredWithDate||0);
    if (k.maxDays !== null && k.maxDays !== undefined) maxDays = (maxDays===null) ? k.maxDays : Math.max(maxDays, k.maxDays);
  }
  var eligible = acc.total - acc.pending;
  return {
    total: acc.total, delivered: acc.delivered, returned: acc.returned, rejected: acc.rejected,
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

// Per-entity (branch/customer/province/area) merge across months. Documented
// approximation: the persisted per-entity summary does not expose pending/
// unknown counts (only shipments/delivered/returned/rejected/withinSla/
// slaBreach), so "eligible" here uses resolved = delivered+returned+rejected
// instead of total-pending. When pending/unknown are near zero (the normal
// case) this matches the exact formula; it slightly understates eligible
// (inflating return/reject rate) only when a branch/customer/etc. has a
// meaningful pending or unclassified-status volume. deliveredWithDate
// (needed for exact avgDays/slaPct weighting) IS reconstructed exactly as
// withinSla+slaBreach — no approximation there.
function summaryMergeGroupLists(listOfArrays, topN) {
  var accMap = {};
  var order = [];
  for (var a = 0; a < listOfArrays.length; a++) {
    var arr = listOfArrays[a] || [];
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!accMap[e.name]) { accMap[e.name] = { shipments:0, delivered:0, returned:0, rejected:0, withinSla:0, slaBreach:0, sumSlaDaysWeighted:0, dwdTotal:0 }; order.push(e.name); }
      var acc = accMap[e.name];
      acc.shipments += e.shipments||0; acc.delivered += e.delivered||0; acc.returned += e.returned||0; acc.rejected += e.rejected||0;
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
    var resolved = acc.delivered + acc.returned + acc.rejected;
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
  var totalRows=0, distinctAwb=0, dupAwbCount=0, invalidDates=0, missingBranch=0, missingClient=0, missingProvince=0, unknownStatusCount=0, negativeCod=0;
  var unknownStatusSet = {};
  var allDupRecords = [];
  var truncated = false;
  var DQ_ALL_MONTHS_CAP = 1000;
  for (var i = 0; i < dqList.length; i++) {
    var dq = dqList[i]; if (!dq) continue;
    totalRows += dq.totalRows||0; distinctAwb += dq.distinctAwb||0; dupAwbCount += dq.dupAwbCount||0;
    invalidDates += dq.invalidDates||0; missingBranch += dq.missingBranch||0; missingClient += dq.missingClient||0;
    missingProvince += dq.missingProvince||0; unknownStatusCount += dq.unknownStatusCount||0; negativeCod += dq.negativeCod||0;
    var usl = dq.unknownStatusList || [];
    for (var u = 0; u < usl.length; u++) unknownStatusSet[usl[u]] = true;
    if (dq.duplicateRecordsTruncated) truncated = true;
    var recs = dq.duplicateRecords || [];
    for (var r = 0; r < recs.length; r++) {
      if (allDupRecords.length < DQ_ALL_MONTHS_CAP) allDupRecords.push(recs[r]);
      else { truncated = true; break; }
    }
  }
  allDupRecords.sort(function (a, b) { return a.awb < b.awb ? -1 : (a.awb > b.awb ? 1 : 0); });
  return {
    totalRows: totalRows, distinctAwb: distinctAwb, dupAwbCount: dupAwbCount, invalidDates: invalidDates,
    missingBranch: missingBranch, missingClient: missingClient, missingProvince: missingProvince,
    unknownStatusCount: unknownStatusCount, unknownStatusList: summaryObjKeysSorted(unknownStatusSet),
    negativeCod: negativeCod, duplicateRecords: allDupRecords, duplicateRecordsTruncated: truncated
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
  }) || !!(params && (params.dateFrom || params.dateTo || params.branch));

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

  // Cache key mirrors the single-month scheme exactly (same helper, same
  // "every calculation-affecting input" rule) — sheet slot is the sentinel.
  var cacheKey = "dash_v3_" + ALL_MONTHS_SENTINEL + "_p_" + summaryHashKey(
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
  var missingSnapshotMonths = [];
  var skippedMonths = [];
  var perMonthSummaries = [];

  for (var i = 0; i < MONTH_ORDER.length; i++) {
    var month = MONTH_ORDER[i];

    if (!hasServerFilters) {
      // FAST PATH (the normal case): reads ONLY the persisted per-month
      // snapshot — never raw rows, never a live aggregation triggered
      // inline. A month without a snapshot yet is reported, not guessed at
      // (use the "Update All 12 Month Summaries" menu to backfill it).
      var snap = getSavedMonthSummary_(month);
      if (!snap) { missingSnapshotMonths.push(month); continue; }
      if (snap.empty || snap.noData) { emptyMonths.push(month); continue; }
      perMonthSummaries.push(snap);
      includedMonths.push(month);
    } else {
      // FILTERED PATH: persisted snapshots are always unfiltered, so a
      // filtered All-Months view needs each month's OWN filtered
      // aggregation — the exact same live-or-CacheService-cached path a
      // single-month filtered request already uses (still Compact Summary
      // only). Bounded by a wall-clock budget: never stacks unlimited
      // 100k-row live computations in one request.
      var elapsed = new Date().getTime() - t0;
      if (elapsed > ALL_MONTHS_TIME_BUDGET_MS) { skippedMonths.push(month); continue; }
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
    }
  }

  if (!includedMonths.length) {
    return {
      success: true, sheet: ALL_MONTHS_SENTINEL, source: "ALL", empty: true, noData: true,
      totalRows: 0, grandTotal: 0,
      attemptSummary: { first:0, second:0, other:0, na:0, total:0 },
      timeSeries: { daily:[], weekly:[], monthly:[] },
      dataQuality: { totalRows:0, distinctAwb:0, dupAwbCount:0, invalidDates:0, missingBranch:0, missingClient:0, missingProvince:0, unknownStatusCount:0, unknownStatusList:[], negativeCod:0, duplicateRecords:[], duplicateRecordsTruncated:false },
      facets: { provinces:[], branches:[], clients:[], statuses:[], areasAll:[], areasByProvince:{} },
      colMap: {}, allMonths: true, includedMonths: [], emptyMonths: emptyMonths,
      missingSnapshotMonths: missingSnapshotMonths, skippedMonths: skippedMonths, partial: !!skippedMonths.length,
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
    partial: !!skippedMonths.length,
    cached: false
  };

  try {
    var serialized = JSON.stringify(result);
    if (serialized.length < 3000000) cachePutChunked(cache, cacheKey, serialized, DASHBOARD_CACHE_TTL_SECONDS);
  } catch (cacheErr) { /* non-fatal */ }

  var tTotal = new Date().getTime() - t0;
  console.log("[TIMING] " + JSON.stringify({
    requestId: params.__requestId || null, sheet: ALL_MONTHS_SENTINEL, totalMs: tTotal,
    includedMonths: includedMonths.length, missingSnapshotMonths: missingSnapshotMonths.length,
    skippedMonths: skippedMonths.length, filtered: hasServerFilters
  }));
  if (debugMode) {
    result.debug = {
      totalMs: tTotal, includedMonths: includedMonths, missingSnapshotMonths: missingSnapshotMonths,
      skippedMonths: skippedMonths, filtered: hasServerFilters
    };
  }

  return result;
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
  return { success:true, month:sheetName, quarter:quarter, chunks:chunks.length };
}

function buildAndSaveMonthSummary(sheetName) {
  if (!MONTH_SOURCE.hasOwnProperty(sheetName)) {
    return { success:false, error:"شهر غير معروف: " + sheetName };
  }
  var started = new Date().getTime();
  var params = { __buildPersistentSummary:true, refresh:"1" };
  var summary = getMonthDashboardSummary(sheetName, params);
  if (!summary || summary.success === false) return summary || {success:false,error:"فشل بناء Summary"};
  summary.persistent = true;
  summary.snapshot = true;
  summary.generatedAt = summary.generatedAt || new Date().toISOString();
  var saved = saveMonthSummary_(sheetName, summary);
  return {
    success:true,
    month:sheetName,
    source:MONTH_SOURCE[sheetName],
    totalRows:Number(summary.totalRows || 0),
    grandTotal:Number(summary.grandTotal || 0),
    empty:!!(summary.empty || summary.noData),
    generatedAt:summary.generatedAt,
    durationMs:new Date().getTime()-started,
    chunks:saved.chunks
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

function onOpen() {
  SpreadsheetApp.getUi().createMenu("ARRIVE Dashboard")
    .addItem("Update Current Quarter Summaries", "updateCurrentQuarterSummaries")
    .addItem("Update All 12 Month Summaries", "buildAllDashboardSummaries")
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
      []

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


// ============================================================
// 9. JSON RESPONSE
// ============================================================

function jsonResponse(obj) {

  return ContentService

    .createTextOutput(
      JSON.stringify(obj)
    )

    .setMimeType(
      ContentService.MimeType.TEXT
    );

}
