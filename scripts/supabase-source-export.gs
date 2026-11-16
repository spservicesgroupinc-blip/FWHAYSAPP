/*
 * Read-only extraction helpers for an isolated copy of the existing Apps Script
 * project. Invoke through the Apps Script Execution API as an authorized account;
 * do not deploy these functions as a public web endpoint. See the runbook.
 * Each sheet call returns a bounded page with its original column positions.
 */
function supabaseExportSheetPage(sheetName, offset, limit) {
  const allowed = ['Requests', 'Jobs', 'Workspaces', 'JobDocuments', 'Customers', 'CustomerActivities', 'Tasks', 'CustomerReference'];
  if (allowed.indexOf(sheetName) < 0 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error('Invalid export page');
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID is not configured');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(sheetName);
  if (!sheet) return { sheetName: sheetName, exists: false, rows: [], nextOffset: null };
  const last = sheet.getLastRow();
  const width = sheet.getLastColumn();
  const start = offset + 1;
  const count = Math.max(0, Math.min(limit, last - offset));
  const rows = count && width ? sheet.getRange(start, 1, count, width).getValues().map(function (row) {
    return row.map(function (value) { return value instanceof Date ? value.toISOString() : value; });
  }) : [];
  return { sheetName: sheetName, exists: true, rows: rows, nextOffset: start + count <= last ? offset + count : null };
}

/* Snapshot JSON only. Binary files should be copied with authenticated Drive
 * tooling, then SHA-256 hashed locally; do not route large PDFs through here. */
function supabaseExportSnapshot(fileId) {
  if (typeof fileId !== 'string' || !fileId || fileId.length > 500) throw new Error('Invalid file ID');
  const file = DriveApp.getFileById(fileId);
  const text = file.getBlob().getDataAsString('UTF-8');
  return { fileId: fileId, snapshot: JSON.parse(text) };
}
