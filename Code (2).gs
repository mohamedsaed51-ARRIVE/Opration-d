/**
 * ARRIVE Shipments Dashboard — Apps Script data backend
 * ------------------------------------------------------
 * Paste this into: Extensions ▸ Apps Script (inside the Google Sheet
 * that holds your shipment data), replacing any existing code, then
 * deploy it as a Web App (see instructions below).
 *
 * It returns the requested sheet's data as JSON:
 *   { rows: [ [header1, header2, ...], [val1, val2, ...], ... ] }
 * exactly the shape the dashboard's loadDataFromGoogleSheet() expects.
 */

function doGet(e) {
  try {
    var sheetName = (e && e.parameter && e.parameter.sheet) || 'Sheet1';
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      return jsonResponse({ error: 'الشيت غير موجود: ' + sheetName });
    }

    var range = sheet.getDataRange();
    var values = range.getValues(); // array of arrays, first row = headers

    if (!values || values.length === 0) {
      return jsonResponse({ error: 'الشيت فارغ: ' + sheetName });
    }

    // Convert Date cells to ISO strings so JSON.stringify doesn't mangle them
    // and the dashboard's date parser reads them consistently.
    var tz = Session.getScriptTimeZone();
    var rows = values.map(function (row) {
      return row.map(function (cell) {
        if (Object.prototype.toString.call(cell) === '[object Date]') {
          return Utilities.formatDate(cell, tz, "yyyy-MM-dd'T'HH:mm:ss");
        }
        return cell;
      });
    });

    return jsonResponse({ rows: rows });
  } catch (err) {
    return jsonResponse({ error: String(err && err.message ? err.message : err) });
  }
}

/**
 * Returns JSON but with mime type text/plain on purpose: Apps Script
 * doesn't handle the CORS pre-flight (OPTIONS) request, so a real
 * "application/json" content type makes browsers block the fetch.
 * text/plain keeps it a "simple request" (no pre-flight) while the
 * dashboard still JSON.parse()s the body itself.
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.TEXT);
}
