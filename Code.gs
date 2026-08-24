/**
 * ARRIVE Shipments Dashboard — Apps Script data backend (Multi-Spreadsheet)
 * --------------------------------------------------------------------------
 * One Web App endpoint serving 4 separate Google Spreadsheets (Q1–Q4).
 *
 * Q1 → January, February, March
 * Q2 → April, May, June
 * Q3 → July, August, September
 * Q4 → October, November, December
 *
 * Supported requests:
 *
 *   ?action=listSheets
 *      Returns all available month tabs from all four spreadsheets.
 *
 *   ?sheet=<month name>
 *      Returns the data for ONE requested month.
 */

// ---------------------------------------------------------------------
// 1. SOURCE CONFIGURATION
// ---------------------------------------------------------------------

var SPREADSHEET_IDS = {
  Q1: "1_JaWfM199wOhRw2-7znStlvw9R2hENWg8s-6Dc_zYWU",
  Q2: "1auCRCzBQcO-ej4JeoEyYzhfBiGtlBb9WdM4iCbNNxkA",
  Q3: "1FUCWpI3DvJ6FRiEJ7eR6wNIn6iLIcJ_PSBBgxT74jJo",
  Q4: "1EosPPKKZ549a6cEGcF_7sCuG9W_ZQmbi6s0MQgehdTs"
};


// ---------------------------------------------------------------------
// 2. MONTH → QUARTER MAPPING
// ---------------------------------------------------------------------

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


// ---------------------------------------------------------------------
// 3. MAIN WEB APP ENDPOINT
// ---------------------------------------------------------------------

function doGet(e) {

  try {

    var action =
      (e && e.parameter && e.parameter.action) || "";


    // ---------------------------------------------------------------
    // LIST ALL MONTHS
    // ---------------------------------------------------------------

    if (action === "listSheets") {

      return jsonResponse(
        listSheetsPayload()
      );

    }


    // ---------------------------------------------------------------
    // REQUEST ONE MONTH
    // ---------------------------------------------------------------

    var sheetName =
      (e && e.parameter && e.parameter.sheet) || "";


    if (!sheetName) {

      return jsonResponse({
        success: false,
        error:
          "لم يتم تحديد الشهر. الرجاء إرسال ?sheet=<اسم الشهر> (مثال: ?sheet=July)."
      });

    }


    // ---------------------------------------------------------------
    // FIND QUARTER
    // ---------------------------------------------------------------

    var quarter =
      MONTH_SOURCE[sheetName];


    if (!quarter) {

      return jsonResponse({
        success: false,
        error:
          "شهر غير معروف: " +
          sheetName +
          ". الأشهر المتاحة: " +
          Object.keys(MONTH_SOURCE).join(", ")
      });

    }


    // ---------------------------------------------------------------
    // FIND SPREADSHEET ID
    // ---------------------------------------------------------------

    var spreadsheetId =
      SPREADSHEET_IDS[quarter];


    if (!spreadsheetId) {

      return jsonResponse({
        success: false,
        error:
          "لا يوجد Spreadsheet ID مُعرَّف للمصدر " +
          quarter +
          " (الشهر المطلوب: " +
          sheetName +
          ")."
      });

    }


    // ---------------------------------------------------------------
    // OPEN CORRECT SPREADSHEET
    // ---------------------------------------------------------------

    var ss;

    try {

      ss =
        SpreadsheetApp.openById(
          spreadsheetId
        );

    } catch (openErr) {

      return jsonResponse({
        success: false,
        error:
          "تعذر فتح الجدول (" +
          quarter +
          ") الخاص بالشهر " +
          sheetName +
          ". تفاصيل: " +
          String(
            openErr &&
            openErr.message
              ? openErr.message
              : openErr
          )
      });

    }


    // ---------------------------------------------------------------
    // FIND MONTH TAB
    // ---------------------------------------------------------------

    var sheet =
      ss.getSheetByName(
        sheetName
      );


    if (!sheet) {

      return jsonResponse({
        success: false,
        error:
          "الشيت غير موجود: " +
          sheetName +
          " (المصدر المتوقع: " +
          quarter +
          ", Spreadsheet ID: " +
          spreadsheetId +
          ")"
      });

    }


    // ---------------------------------------------------------------
    // READ DATA
    // ---------------------------------------------------------------

    var range =
      sheet.getDataRange();

    var values =
      range.getValues();


    if (!values || values.length === 0) {

      return jsonResponse({
        success: false,
        error:
          "الشيت فارغ: " +
          sheetName +
          " (المصدر: " +
          quarter +
          ")"
      });

    }


    // ---------------------------------------------------------------
    // NORMALIZE DATE VALUES
    // ---------------------------------------------------------------

    var tz =
      Session.getScriptTimeZone();


    var rows =
      values.map(function(row) {

        return row.map(function(cell) {

          if (
            Object.prototype.toString.call(cell) ===
            "[object Date]"
          ) {

            return Utilities.formatDate(
              cell,
              tz,
              "yyyy-MM-dd'T'HH:mm:ss"
            );

          }

          return cell;

        });

      });


    // ---------------------------------------------------------------
    // RETURN DATA
    // ---------------------------------------------------------------

    return jsonResponse({
      success: true,
      rows: rows,
      month: sheetName,
      quarter: quarter
    });


  } catch (err) {

    return jsonResponse({
      success: false,
      error:
        String(
          err &&
          err.message
            ? err.message
            : err
        )
    });

  }

}


// ---------------------------------------------------------------------
// 4. LIST MONTHS FROM ALL FOUR SPREADSHEETS
// ---------------------------------------------------------------------

function listSheetsPayload() {

  var allMonths = [];

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


    try {

      var ss =
        SpreadsheetApp.openById(
          spreadsheetId
        );


      var tabNames =
        ss
          .getSheets()
          .map(function(s) {

            return s.getName();

          });


      for (
        var j = 0;
        j < tabNames.length;
        j++
      ) {

        var name =
          tabNames[j];


        if (
          Object.prototype.hasOwnProperty.call(
            MONTH_SOURCE,
            name
          )
        ) {

          allMonths.push(
            name
          );

        }

      }


    } catch (err) {

      // Continue with the remaining spreadsheets.
      continue;

    }

  }


  // Remove duplicates while preserving order.

  var uniqueMonths = [];

  var seen = {};

  for (
    var k = 0;
    k < allMonths.length;
    k++
  ) {

    var month =
      allMonths[k];

    if (!seen[month]) {

      seen[month] = true;

      uniqueMonths.push(
        month
      );

    }

  }


  return {
    success: true,
    sheets: uniqueMonths,

    sources: {

      Q1: getSourceStatus(
        "Q1",
        [
          "January",
          "February",
          "March"
        ]
      ),

      Q2: getSourceStatus(
        "Q2",
        [
          "April",
          "May",
          "June"
        ]
      ),

      Q3: getSourceStatus(
        "Q3",
        [
          "July",
          "August",
          "September"
        ]
      ),

      Q4: getSourceStatus(
        "Q4",
        [
          "October",
          "November",
          "December"
        ]
      )

    },

    expectedMonths: [
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
    ]

  };

}


// ---------------------------------------------------------------------
// 5. CHECK EACH QUARTER SOURCE
// ---------------------------------------------------------------------

function getSourceStatus(
  quarter,
  expectedMonths
) {

  var spreadsheetId =
    SPREADSHEET_IDS[quarter];


  try {

    var ss =
      SpreadsheetApp.openById(
        spreadsheetId
      );


    var actualTabs =
      ss
        .getSheets()
        .map(function(s) {

          return s.getName();

        });


    var availableMonths =
      expectedMonths.filter(
        function(month) {

          return actualTabs.indexOf(
            month
          ) !== -1;

        }
      );


    return {

      status:
        "OK",

      spreadsheetId:
        spreadsheetId,

      months:
        availableMonths

    };


  } catch (err) {

    return {

      status:
        "ERROR",

      spreadsheetId:
        spreadsheetId,

      months:
        [],

      error:
        String(
          err &&
          err.message
            ? err.message
            : err
        )

    };

  }

}


// ---------------------------------------------------------------------
// 6. JSON RESPONSE
// ---------------------------------------------------------------------

function jsonResponse(obj) {

  return ContentService
    .createTextOutput(
      JSON.stringify(obj)
    )
    .setMimeType(
      ContentService.MimeType.TEXT
    );

}
