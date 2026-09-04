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
// 5. MAIN ENTRY
// ============================================================

function doGet(e) {

  try {

    var params =
      (e && e.parameter)
        ? e.parameter
        : {};

    var action =
      params.action || "";

    var sheetName =
      params.sheet || "";


    // --------------------------------------------------------
    // LIST MONTHS
    // --------------------------------------------------------

    if (action === "listSheets") {

      return jsonResponse(
        listSheetsPayload()
      );

    }


    // --------------------------------------------------------
    // DIAGNOSTIC
    // --------------------------------------------------------

    if (action === "diagnose") {

      return jsonResponse(
        diagnoseMonth(sheetName)
      );

    }


    // --------------------------------------------------------
    // DASHBOARD SUMMARY (server-side aggregation — compact JSON,
    // no raw rows). This is what the Dashboard now uses for the normal
    // KPI/overview view instead of downloading the entire raw month.
    // --------------------------------------------------------

    if (action === "dashboard") {

      if (!sheetName) {
        return jsonResponse({
          success: false,
          error: "لم يتم تحديد الشهر. استخدم ?action=dashboard&sheet=July"
        });
      }

      return jsonResponse(
        getMonthDashboardSummary(sheetName, params)
      );

    }


    // --------------------------------------------------------
    // NORMAL DATA REQUEST
    // --------------------------------------------------------

    if (!sheetName) {

      return jsonResponse({

        success: false,

        error:
          "لم يتم تحديد الشهر. استخدم ?sheet=July"

      });

    }


    return jsonResponse(
      getMonthPage(
        sheetName,
        params
      )
    );

  }

  catch (err) {

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

function summaryClassifyStatus(status) {
  var n = summaryNormText(status);
  var buckets = Object.keys(SUMMARY_STATUS_MAP);
  for (var i = 0; i < buckets.length; i++) {
    var vals = SUMMARY_STATUS_MAP[buckets[i]];
    for (var v = 0; v < vals.length; v++) {
      if (summaryNormText(vals[v]) === n) return buckets[i];
    }
  }
  return "unknown";
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

function getMonthDashboardSummary(sheetName, params) {

  if (!MONTH_SOURCE.hasOwnProperty(sheetName)) {
    return { success: false, error: "شهر غير معروف: " + sheetName };
  }

  var filters = summaryParseFilters(params);
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
  var dateFrom = (params && params.dateFrom) ? params.dateFrom : "";
  var dateTo = (params && params.dateTo) ? params.dateTo : "";
  var branchFilter = (filters.branch && filters.branch.length === 1) ? filters.branch[0] : ""; // kept for legacy response field only
  var forceRefresh = params && (params.refresh === "1" || params.refresh === "true");
  var hasFilters = Object.keys(filters).length > 0 || dateFrom || dateTo;
  var cacheKeySuffix = hasFilters ? ("_f_" + summaryHashKey(JSON.stringify(filters) + "|" + dateFrom + "|" + dateTo + "|" + attemptT1 + "|" + attemptT2)) : "";
  cacheKeySuffix += "_sla_" + summaryHashKey(slaTargetDefault + "|" + JSON.stringify(branchSlaTargets));
  var cacheKey = "dash_v2_" + sheetName + cacheKeySuffix;
  var cache = CacheService.getScriptCache();

  if (!forceRefresh) {
    var cached = cache.get(cacheKey);
    if (cached) {
      var cachedObj = JSON.parse(cached);
      cachedObj.cached = true;
      return cachedObj;
    }
  }

  var quarter = MONTH_SOURCE[sheetName];
  var spreadsheetId = SPREADSHEET_IDS[quarter];

  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (err) {
    return { success: false, error: "تعذر فتح Spreadsheet " + quarter + ": " + String(err && err.message ? err.message : err) };
  }

  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    return { success: false, error: "الشيت غير موجود: " + sheetName + " داخل " + quarter };
  }

  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();

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
  var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var headers = values[0];
  var dataRows = values.slice(1);

  var hasAnyContent = dataRows.some(function (row) {
    return row.some(function (cell) { return cell !== "" && cell !== null; });
  });
  if (!hasAnyContent) {
    return { success: true, sheet: sheetName, source: quarter, empty: true, noData: true, totalRows: 0, grandTotal: 0, attemptSummary: { first:0, second:0, other:0, na:0, total:0 }, timeSeries: { daily:[], weekly:[], monthly:[] }, dataQuality: { totalRows:0, distinctAwb:0, dupAwbCount:0, invalidDates:0, missingBranch:0, missingClient:0, missingProvince:0, unknownStatusCount:0, unknownStatusList:[], negativeCod:0, duplicateRecords:[], duplicateRecordsTruncated:false }, facets: { provinces:[], branches:[], clients:[], statuses:[], areasAll:[], areasByProvince:{} }, colMap: {}, generatedAt: new Date().toISOString() };
  }

  var colMap = summaryDetectColumnMap(headers);
  var idx = {};
  var mappedFields = Object.keys(colMap);
  for (var mf = 0; mf < mappedFields.length; mf++) {
    idx[mappedFields[mf]] = headers.indexOf(colMap[mappedFields[mf]]);
  }

  var awbMap = {}; // awb -> latest row object (dedup, matches dedupeForKPI)
  var dupCount = 0;
  var invalidDates = 0;
  // Data Quality counters — computed on every non-empty, has-AWB row (matches
  // the client's old buildRowsAndDQFromHeaderedData: totalRows only counts
  // rows that would have been pushed into its `rows` array).
  var dqTotalRows = 0, missingBranch = 0, missingClient = 0, missingProvince = 0, negativeCod = 0, unknownStatusCount = 0;
  var unknownStatusSet = {};
  var seenAwbCount = {}; // awb -> occurrence count, for duplicate detection (see pass 2 below)

  for (var ri = 0; ri < dataRows.length; ri++) {
    var row = dataRows[ri];
    var allEmpty = row.every(function (c) { return c === null || c === "" || c === undefined; });
    if (allEmpty) continue;

    var get = function (field) { return (idx[field] !== undefined && idx[field] >= 0) ? row[idx[field]] : null; };
    var awb = summaryNormText(get("awb"));
    if (!awb) continue;

    dqTotalRows++;
    seenAwbCount[awb] = (seenAwbCount[awb] || 0) + 1;

    var pickup = summaryParseDate(get("pickup"));
    var lastStatus = summaryParseDate(get("lastStatus"));
    if (!pickup) invalidDates++;

    var status = summaryNormText(get("status"));
    var bucket = summaryClassifyStatus(status);
    if (bucket === "unknown" && status) { unknownStatusSet[status] = true; unknownStatusCount++; }
    var branch = summaryNormText(get("branch"));
    if (!branch) missingBranch++;
    var client = summaryNormText(get("client"));
    if (!client) missingClient++;
    var province = summaryNormText(get("province"));
    if (!province) missingProvince++;
    var area = summaryNormText(get("area"));
    var finalStatus = summaryNormText(get("finalStatus"));
    var cod = parseFloat(get("cod")) || 0;
    if (cod < 0) negativeCod++;
    var shipCost = parseFloat(get("shipCost")) || 0;

    var slaDays = null;
    if (pickup && lastStatus) slaDays = (lastStatus.getTime() - pickup.getTime()) / 86400000;
    var attemptCat = summaryClassifyAttempt(slaDays, attemptT1, attemptT2);

    var rec = {
      awb: awb, client: client, province: province, area: area, branch: branch,
      status: status, bucket: bucket, finalStatus: finalStatus,
      pickup: pickup, lastStatus: lastStatus, slaDays: slaDays, cod: cod, shipCost: shipCost,
      attemptCat: attemptCat
    };

    if (awbMap.hasOwnProperty(awb)) {
      dupCount++;
      var existing = awbMap[awb];
      var et = existing.lastStatus ? existing.lastStatus.getTime() : -Infinity;
      var rt = lastStatus ? lastStatus.getTime() : -Infinity;
      if (rt >= et) awbMap[awb] = rec;
    } else {
      awbMap[awb] = rec;
    }
  }

  // Duplicate AWB detail table (Data Quality tab) — pass 2, only runs if
  // duplicates actually exist, over data already in memory (no extra Sheet
  // read). Capped at DQ_MAX_DUPLICATE_RECORDS so this stays a compact
  // diagnostic list, never a raw-row dump.
  var dupAwbSet = {};
  var dupAwbCount = 0;
  for (var awbKey0 in seenAwbCount) {
    if (seenAwbCount.hasOwnProperty(awbKey0) && seenAwbCount[awbKey0] > 1) { dupAwbSet[awbKey0] = true; dupAwbCount++; }
  }
  var DQ_MAX_DUPLICATE_RECORDS = 1000;
  var duplicateRecords = [];
  var duplicateRecordsTruncated = false;
  if (dupAwbCount > 0) {
    for (var ri2 = 0; ri2 < dataRows.length && duplicateRecords.length < DQ_MAX_DUPLICATE_RECORDS; ri2++) {
      var row2 = dataRows[ri2];
      var allEmpty2 = row2.every(function (c) { return c === null || c === "" || c === undefined; });
      if (allEmpty2) continue;
      var get2 = function (field) { return (idx[field] !== undefined && idx[field] >= 0) ? row2[idx[field]] : null; };
      var awb2 = summaryNormText(get2("awb"));
      if (!awb2 || !dupAwbSet[awb2]) continue;
      var pickup2 = summaryParseDate(get2("pickup"));
      var lastStatus2 = summaryParseDate(get2("lastStatus"));
      duplicateRecords.push({
        awb: awb2, client: summaryNormText(get2("client")), status: summaryNormText(get2("status")),
        branch: summaryNormText(get2("branch")),
        pickup: pickup2 ? Utilities.formatDate(pickup2, Session.getScriptTimeZone() || "Africa/Cairo", "yyyy-MM-dd") : "",
        lastStatus: lastStatus2 ? Utilities.formatDate(lastStatus2, Session.getScriptTimeZone() || "Africa/Cairo", "yyyy-MM-dd") : ""
      });
    }
    if (duplicateRecords.length >= DQ_MAX_DUPLICATE_RECORDS) duplicateRecordsTruncated = true;
    duplicateRecords.sort(function (a, b) { return a.awb < b.awb ? -1 : (a.awb > b.awb ? 1 : 0); });
  }
  var dataQuality = {
    totalRows: dqTotalRows,
    distinctAwb: Object.keys(seenAwbCount).length,
    dupAwbCount: dupAwbCount,
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

  var allDedupRows = [];
  for (var awbKey in awbMap) { if (awbMap.hasOwnProperty(awbKey)) allDedupRows.push(awbMap[awbKey]); }

  // Filter-dropdown facets — distinct values per dimension (province/branch/
  // client/status/area) PLUS a province→areas cascade map, all computed from
  // the UNFILTERED month (matches the client's old buildDimensions(), which
  // always derived options from the whole month regardless of active
  // filters). This is what lets the filter UI populate without ever
  // downloading raw rows.
  var provinceSet = {}, branchSet = {}, clientSet = {}, statusSet = {}, areaSet = {};
  var areasByProvinceSets = {};
  for (var fi = 0; fi < allDedupRows.length; fi++) {
    var fr = allDedupRows[fi];
    if (fr.province) provinceSet[fr.province] = true;
    if (fr.branch) branchSet[fr.branch] = true;
    if (fr.client) clientSet[fr.client] = true;
    if (fr.status) statusSet[fr.status] = true;
    if (fr.area) {
      areaSet[fr.area] = true;
      if (fr.province) {
        if (!areasByProvinceSets[fr.province]) areasByProvinceSets[fr.province] = {};
        areasByProvinceSets[fr.province][fr.area] = true;
      }
    }
  }
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

  // Unfiltered grand total (all dimensions ignored) — matches the client's
  // STATE.grandTotalShipments, used only for the "من إجمالي الشحنات الكلي"
  // KPI sub-label. Cheap: just a length count on data already in memory.
  var grandTotal = allDedupRows.length;

  // Multi-dimension filtering (province/area/branch/client/status/attempt +
  // pickup date range), entirely server-side. Replaces the old branch-only
  // filter — this is what lets the Overview/KPI tab and, going forward, every
  // other tab and Management Analysis drill-down run off compact aggregates
  // for ANY combination of filters, never raw rows.
  var dedupRows = summaryApplyFilters(allDedupRows, filters, [], dateFrom, dateTo);

  var kpis = summaryComputeKPIs(dedupRows, branchSlaTargets, slaTargetDefault);

  var statusSummary = {}, finalStatusSummary = {};
  for (var d = 0; d < dedupRows.length; d++) {
    var st = dedupRows[d].status || "غير محدد";
    statusSummary[st] = (statusSummary[st] || 0) + 1;
    var fs = dedupRows[d].finalStatus || "غير محدد";
    finalStatusSummary[fs] = (finalStatusSummary[fs] || 0) + 1;
  }

  // Attempt-distribution baseline: same active filters EXCEPT the attempt
  // dimension itself, so each bucket's % is always "out of total orders under
  // the other active filters" and doesn't shrink when the attempt filter is
  // used to narrow the view — mirrors the client's getFilteredRowsExcluding('attemptCategory').
  var attemptBaseRows = summaryApplyFilters(allDedupRows, filters, ["attempt"], dateFrom, dateTo);
  var attemptSummary = { first: 0, second: 0, other: 0, na: 0, total: attemptBaseRows.length };
  for (var ab = 0; ab < attemptBaseRows.length; ab++) attemptSummary[attemptBaseRows[ab].attemptCat]++;

  // Overview tab's 14-day mini trend — kept in its existing {date,count,delivered}
  // shape (see renderOverviewTabFromServer in dashboard.html); the Growth/Trend
  // tab's daily/weekly/monthly series below is a separate field, different shape.
  var trendMapFiltered = {};
  for (var tf = 0; tf < dedupRows.length; tf++) {
    var trec = dedupRows[tf];
    if (!trec.pickup) continue;
    var tDayKey = Utilities.formatDate(trec.pickup, Session.getScriptTimeZone() || "Africa/Cairo", "yyyy-MM-dd");
    if (!trendMapFiltered[tDayKey]) trendMapFiltered[tDayKey] = { date: tDayKey, count: 0, delivered: 0 };
    trendMapFiltered[tDayKey].count++;
    if (trec.bucket === "delivered") trendMapFiltered[tDayKey].delivered++;
  }
  var trend = [];
  for (var tKey in trendMapFiltered) { if (trendMapFiltered.hasOwnProperty(tKey)) trend.push(trendMapFiltered[tKey]); }
  trend.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  // Growth/Trend tab — all three granularities computed once here (cheap:
  // just grouping the same already-filtered dedupRows already in memory),
  // so the client never needs to pick one ahead of time or re-request.
  var timeSeries = {
    daily: summaryBuildTimeSeries(dedupRows, "daily"),
    weekly: summaryBuildTimeSeries(dedupRows, "weekly"),
    monthly: summaryBuildTimeSeries(dedupRows, "monthly")
  };

  var totalCod = 0, totalShipCost = 0;
  for (var c = 0; c < dedupRows.length; c++) { totalCod += dedupRows[c].cod; totalShipCost += dedupRows[c].shipCost; }

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
      totalRows: dedupRows.length,
      distinctAwb: dedupRows.length,
      dupAwbCount: dupCount,
      invalidDates: invalidDates
    },
    totalCod: totalCod,
    totalShipCost: totalShipCost,
    branchSummary: summaryGroupBy(dedupRows, "branch", 3000, branchSlaTargets, slaTargetDefault),
    customerSummary: summaryGroupBy(dedupRows, "client", 3000, branchSlaTargets, slaTargetDefault),
    provinceSummary: summaryGroupBy(dedupRows, "province", 1000, branchSlaTargets, slaTargetDefault),
    areaSummary: summaryGroupBy(dedupRows, "area", 1000, branchSlaTargets, slaTargetDefault),
    statusSummary: statusSummary,
    finalStatusSummary: finalStatusSummary,
    trend: trend,
    timeSeries: timeSeries,
    dataQuality: dataQuality,
    colMap: colMap,
    facets: facets,
    cached: false
  };

  try {
    var serialized = JSON.stringify(result);
    // CacheService values are capped at 100KB — if a month's aggregate is
    // unusually large (very many distinct branches/customers), skip caching
    // rather than failing the request; the response itself is still returned.
    if (serialized.length < 100000) {
      cache.put(cacheKey, serialized, DASHBOARD_CACHE_TTL_SECONDS);
    }
  } catch (cacheErr) {
    // Non-fatal — caching is a performance optimization, not a requirement.
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
// 7. LIST ALL MONTHS
// ============================================================

function listSheetsPayload() {

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


  return {

    success: true,

    sheets:
      allMonths,

    sources:
      sources,

    expectedMonths:
      MONTH_ORDER

  };

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