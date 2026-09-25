'use strict';
// FICTITIOUS test data only. Every AWB, client, branch, province and area
// below is invented ("TEST-…", "تجريبي"). Nothing here comes from, or is
// derived from, ARRIVE production sheets.
//
// Header names are the exact column names Code.gs / index.html already
// recognise (SUMMARY_COLUMN_ALIASES / COLUMN_ALIASES), so both sides map the
// same columns.
//
// Dates are Cairo local time (tests/helpers/harness.js fixes TZ before this
// file is loaded) and are passed as Date objects, which is what Apps
// Script's getValues() returns for real date cells.

const HEADERS = [
  'رقم البوليصة', 'الراسل', 'المحافظة', 'المنطقة', 'الفرع',
  'حالة الشحنة', 'تاريخ استلام البيك أب', 'تاريخ آخر حالة', 'مبلغ التحصيل', 'تكلفة الشحن',
];

const BR_A = 'فرع تجريبي أ';
const BR_B = 'فرع تجريبي ب';
const CL_1 = 'عميل تجريبي 1';
const CL_2 = 'عميل تجريبي 2';
const PROV = 'محافظة تجريبية';
const AREA = 'منطقة تجريبية';

const S = {
  delivered: 'تسليم ناجح',
  returned: 'مرتجعات',
  rejectedPaid: 'رفض الاستلام و تم دفع الشحن',
  rejectedPaidHamza: 'رفض الإستلام و تم دفع الشحن', // same status, spelled with إ
  pending: 'قيد التشغيل',
  unknown: 'حالة تجريبية غير معروفة',
};

function d(s) { return new Date(s); } // local (Cairo) time

// One row per line: [awb, client, province, area, branch, status, pickup, lastStatus, cod, shipCost]
// Comments give the SLA day span (lastStatus - pickup) for delivered rows.
function julyRows() {
  return [
    ['TEST-001', CL_1, PROV, AREA, BR_A, S.delivered, d('2026-07-01T08:00:00'), d('2026-07-02T08:00:00'), 100, 30], // 1.0 day
    ['TEST-002', CL_1, PROV, AREA, BR_A, S.delivered, d('2026-07-01T08:00:00'), d('2026-07-03T08:00:00'), 100, 30], // exactly 2.0 days (= default target)
    ['TEST-003', CL_1, PROV, AREA, BR_A, S.delivered, d('2026-07-01T08:00:00'), d('2026-07-03T09:00:00'), 100, 30], // 2.0417 days (1 hour over target)
    ['TEST-004', CL_2, PROV, AREA, BR_B, S.delivered, d('2026-07-05T10:00:00'), d('2026-07-05T18:00:00'), 100, 30], // same day, 0.333 days
    ['TEST-005', CL_2, PROV, AREA, BR_B, S.delivered, '',                       d('2026-07-06T12:00:00'), 100, 30], // no pickup date
    ['TEST-006', CL_1, PROV, AREA, BR_A, S.returned, d('2026-07-02T08:00:00'), d('2026-07-06T08:00:00'), 0, 30],
    ['TEST-007', CL_2, PROV, AREA, BR_B, S.rejectedPaid, d('2026-07-02T08:00:00'), d('2026-07-04T08:00:00'), 0, 30],
    ['TEST-008', CL_2, PROV, AREA, BR_B, S.rejectedPaidHamza, d('2026-07-02T08:00:00'), d('2026-07-04T08:00:00'), 0, 30],
    ['TEST-009', CL_1, PROV, AREA, BR_A, S.pending, d('2026-07-07T08:00:00'), d('2026-07-08T08:00:00'), 0, 30],
    ['TEST-010', CL_2, PROV, AREA, BR_B, S.unknown, d('2026-07-07T08:00:00'), d('2026-07-08T08:00:00'), 0, 30],
    // TEST-011: duplicated — older record pending, newer record delivered → newer (delivered) must win
    ['TEST-011', CL_1, PROV, AREA, BR_A, S.pending, d('2026-07-01T08:00:00'), d('2026-07-02T08:00:00'), 0, 30],
    ['TEST-011', CL_1, PROV, AREA, BR_A, S.delivered, d('2026-07-01T08:00:00'), d('2026-07-04T08:00:00'), 100, 30], // 3.0 days
    // TEST-012: duplicated with IDENTICAL lastStatus — returned first, pending second → later row wins (>=)
    ['TEST-012', CL_1, PROV, AREA, BR_A, S.returned, d('2026-07-03T08:00:00'), d('2026-07-05T08:00:00'), 0, 30],
    ['TEST-012', CL_1, PROV, AREA, BR_A, S.pending, d('2026-07-03T08:00:00'), d('2026-07-05T08:00:00'), 0, 30],
    ['TEST-013', CL_2, PROV, AREA, BR_B, S.delivered, d('2026-07-01T08:00:00'), d('2026-07-02T20:00:00'), 100, 30], // 1.5 days elapsed, but only 1 calendar day apart
    ['', CL_1, PROV, AREA, BR_A, S.delivered, d('2026-07-01T08:00:00'), d('2026-07-02T08:00:00'), 100, 30], // no AWB → ignored
    ['', '', '', '', '', '', '', '', '', ''], // fully blank row → ignored
  ];
}

// Hand-computed expectations for julyRows() under the CURRENT code
// (default SLA target = 2 days, no branch overrides). See tests/README.md.
const JULY_EXPECTED_BACKEND = {
  total: 13, delivered: 7, returned: 1, rejected: 2, pending: 2, unknown: 1, eligible: 11,
  deliveryRate: 7 / 13 * 100,
  returnRate: 1 / 11 * 100,
  rejectedRate: 2 / 11 * 100,
  successRate: 9 / 13 * 100,
  deliveredWithDate: 6, withinSla: 4, slaBreach: 2,
  slaAchievement: 4 / 6 * 100,
  avgDays: (1 + 2 + (2 + 1 / 24) + (8 / 24) + 3 + 1.5) / 6,
  medianDays: 2, // upper median of [0.333, 1, 1.5, 2, 2.0417, 3]
  maxDays: 3,
};

module.exports = { HEADERS, julyRows, JULY_EXPECTED_BACKEND, S, BR_A, BR_B, CL_1, CL_2, PROV, AREA, d };
