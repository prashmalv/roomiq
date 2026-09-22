import ExcelJS from 'exceljs';

/* ---------------------------------------------------------------------------
   Real .xlsx rather than CSV. A CSV would be less code, but Excel mangles it:
   an amenity list containing a comma splits into columns, a pass code loses its
   leading zeros, and dd/mm dates get reinterpreted. Typed cells avoid all of it.
--------------------------------------------------------------------------- */

const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A3D6E' } };

/** One sheet, header styled, columns sized, filter and freeze applied. */
export function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  head.fill = HEAD_FILL;
  head.alignment = { vertical: 'middle' };
  head.height = 22;

  for (const r of rows) ws.addRow(r);

  // Let facilities sort and filter without setting it up themselves.
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  for (const c of columns) {
    if (!c.numFmt) continue;
    ws.getColumn(c.key).numFmt = c.numFmt;
  }
  return ws;
}

export async function workbookBuffer(build) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'UneeRooms';
  wb.created = new Date();
  await build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Send a workbook as a download with a dated filename. */
export function sendWorkbook(res, filename, buf) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}

/** Read the first sheet of an uploaded workbook as objects keyed by header. */
export async function readSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('That file has no sheets.');

  const headers = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col] = String(cell.value ?? '').trim().toLowerCase();
  });

  const out = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj = {};
    let empty = true;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      // Excel hands back objects for formulas, links and rich text.
      let v = cell.value;
      if (v && typeof v === 'object') v = v.result ?? v.text ?? v.hyperlink ?? '';
      v = v === null || v === undefined ? '' : String(v).trim();
      if (v !== '') empty = false;
      obj[key] = v;
    });
    if (!empty) out.push({ row: n, ...obj });
  });
  return out;
}
