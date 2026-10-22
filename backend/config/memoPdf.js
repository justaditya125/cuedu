const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// The same emblem logo as the site header. Its proportions are read from the PNG
// header so the layout never depends on a hard-coded size.
const LOGO = path.join(__dirname, '..', 'assets', 'memo-logo.png');
const LOGO_PNG = fs.readFileSync(LOGO);
const LOGO_RATIO = LOGO_PNG.readUInt32BE(16) / LOGO_PNG.readUInt32BE(20);   // width / height

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = PAGE_H - 56;            // lowest y a table row may reach
const PAD_X = 6;
const PAD_Y = 5;

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';

// Fixed text from the university's memo template.
const GRADE_LEGEND = {
  ranges: ['90-100', '80-90', '70-80', '60-70', '50-60', '40-50', '0-39', 'ABSENT'],
  grades: ['O', 'E', 'A', 'B', 'C', 'D', 'F', 'AB'],
  points: ['10', '9', '8', '7', '6', '5', '2', '']
};
const SGPA_NOTE = 'Note:The SGPA indicated in the results corresponds only to the latest and freshly attempted semester.';
const SUPPLEMENTARY_NOTE = '# - Denotes Supplementary Course';
const FOOTER_NOTE = 'This is Electronically generated Marks Memo';

// One bordered row. Height follows the tallest cell so long paper names wrap
// rather than being cut off; a row that will not fit moves to a new page.
function drawRow(doc, y, cells, opts) {
  const o = Object.assign({ size: 9, minHeight: 22, x: MARGIN }, opts);

  let textH = 0;
  for (const c of cells) {
    doc.font(c.bold || o.bold ? BOLD : REGULAR).fontSize(o.size);
    textH = Math.max(textH, doc.heightOfString(String(c.text), { width: c.w - PAD_X * 2 }));
  }
  const h = Math.max(o.minHeight, textH + PAD_Y * 2);

  if (y + h > BOTTOM) {
    doc.addPage();
    y = MARGIN;
  }

  let x = o.x;
  for (const c of cells) {
    doc.lineWidth(0.7).strokeColor('#000').rect(x, y, c.w, h).stroke();
    doc.font(c.bold || o.bold ? BOLD : REGULAR).fontSize(o.size).fillColor('#000');
    const ty = y + (h - doc.heightOfString(String(c.text), { width: c.w - PAD_X * 2 })) / 2;
    doc.text(String(c.text), x + PAD_X, ty, { width: c.w - PAD_X * 2, align: c.align || 'left', lineBreak: true });
    x += c.w;
  }
  return y + h;
}

function heading(doc, y, text, size, opts) {
  doc.font(BOLD).fontSize(size).fillColor('#000');
  const o = Object.assign({ width: CONTENT_W, align: 'left' }, opts);
  doc.text(text, MARGIN, y, o);
  return y + doc.heightOfString(text, { width: o.width }) ;
}

function drawHeader(doc, memo) {
  // Logo, centred, in the place of the template's "University Logo" box.
  const logoH = 80;
  const logoW = logoH * LOGO_RATIO;
  doc.image(LOGO, (PAGE_W - logoW) / 2, MARGIN - 8, { height: logoH });
  let y = MARGIN - 8 + logoH + 12;

  y = heading(doc, y, memo.title, 12.5) + 12;

  const labelW = CONTENT_W * 0.46;
  const valueW = CONTENT_W - labelW;
  const rows = [
    ['Name', memo.name],
    ['Enrollment Number / Regd. No', memo.enrollmentNo],
    ['ABC ID', memo.abcId],
    ['Program/Course', memo.program],
    ['Mode Of Delivery', memo.mode]
  ];
  for (const [label, value] of rows) {
    y = drawRow(doc, y, [
      { w: labelW, text: label, bold: true },
      { w: valueW, text: value || '' }
    ], { size: 9.5, minHeight: 20 });
  }
  return y + 16;
}

function drawSemesterMemo(doc, memo) {
  let y = drawHeader(doc, memo);

  y = heading(doc, y, 'The following Marks were secured by the learner:', 9) + 8;

  // Header: "Grade Obtained" spans the Grade and Grade Points columns.
  const snoW = 46, gradeW = 100, gpW = 118;
  const nameW = CONTENT_W - snoW - gradeW - gpW;
  const topH = 22;
  doc.lineWidth(0.7).strokeColor('#000');
  doc.rect(MARGIN, y, snoW, topH * 2).stroke();
  doc.rect(MARGIN + snoW, y, nameW, topH * 2).stroke();
  doc.rect(MARGIN + snoW + nameW, y, gradeW + gpW, topH).stroke();
  doc.font(BOLD).fontSize(9).fillColor('#000');
  doc.text('S.No', MARGIN, y + topH - 5, { width: snoW, align: 'center' });
  doc.text('Paper Name', MARGIN + snoW, y + topH - 5, { width: nameW, align: 'center' });
  doc.text('Grade Obtained', MARGIN + snoW + nameW, y + 6, { width: gradeW + gpW, align: 'center' });
  y += topH;
  y = drawRow(doc, y, [
    { w: gradeW, text: 'Grade', bold: true, align: 'center' },
    { w: gpW, text: 'Grade Points', bold: true, align: 'center' }
  ], { x: MARGIN + snoW + nameW, size: 9, minHeight: topH });

  for (const s of memo.subjects) {
    y = drawRow(doc, y, [
      { w: snoW, text: s.sno, align: 'left' },
      { w: nameW, text: s.name },
      { w: gradeW, text: s.grade, align: 'center' },
      { w: gpW, text: s.gradePoint, align: 'center' }
    ], { size: 9, minHeight: 21 });
  }
  y += 18;

  if (y + 190 > BOTTOM) { doc.addPage(); y = MARGIN; }

  y = heading(doc, y, 'Grade Points Average (GPA) Details:', 9) + 7;
  y = heading(doc, y, SGPA_NOTE, 7.5) + 8;

  // SGPA box
  const sgpa = Number.isFinite(parseFloat(memo.sgpa)) ? parseFloat(memo.sgpa).toFixed(2) : memo.sgpa;
  const boxW = 150;
  y = drawRow(doc, y, [{ w: boxW, text: 'Semester Grade Point Average (SGPA)', bold: true, align: 'center' }], { size: 9, minHeight: 44 });
  y = drawRow(doc, y, [{ w: boxW, text: sgpa, align: 'center' }], { size: 9.5, minHeight: 22 });
  y += 18;

  // Grade legend
  const labelW = 78;
  const colW = (CONTENT_W * 0.88 - labelW) / 8;
  const legend = [
    ['Marks Range', GRADE_LEGEND.ranges],
    ['Grade', GRADE_LEGEND.grades],
    ['Grade Points', GRADE_LEGEND.points]
  ];
  for (const [label, values] of legend) {
    y = drawRow(doc, y, [
      { w: labelW, text: label, bold: true },
      ...values.map((v) => ({ w: colW, text: v, align: 'left' }))
    ], { size: 8, minHeight: 20 });
  }
  y += 20;

  if (y + 26 > BOTTOM) { doc.addPage(); y = MARGIN; }
  doc.font(BOLD).fontSize(13).fillColor('#000');
  doc.text('Result: ' + memo.result, MARGIN, y, { width: CONTENT_W });
  y += 28;

  // The notes follow the result. When the page is full they continue on the
  // next one, exactly as page 2 of the university's own template does.
  if (y + 34 > PAGE_H - 50) { doc.addPage(); y = MARGIN; }
  doc.font(REGULAR).fontSize(8.5).fillColor('#000');
  doc.text(SUPPLEMENTARY_NOTE, MARGIN, y, { width: CONTENT_W });
  doc.text(FOOTER_NOTE, MARGIN, y + 16, { width: CONTENT_W });
}

// The re-attempt sheet carries marks and PASS/FAIL but no grade or grade-point
// columns, so those are shown as recorded rather than being derived.
function drawReattemptMemo(doc, memo) {
  let y = drawHeader(doc, memo);

  y = heading(doc, y, 'The following Marks were secured by the learner in the re-attempt examination:', 9) + 8;

  const snoW = 40, markW = 62, resultW = 62;
  const nameW = CONTENT_W - snoW - markW * 3 - resultW;
  y = drawRow(doc, y, [
    { w: snoW, text: 'S.No', bold: true, align: 'center' },
    { w: nameW, text: 'Paper Name', bold: true, align: 'center' },
    { w: markW, text: 'Internal', bold: true, align: 'center' },
    { w: markW, text: 'External', bold: true, align: 'center' },
    { w: markW, text: 'Total', bold: true, align: 'center' },
    { w: resultW, text: 'Result', bold: true, align: 'center' }
  ], { size: 9, minHeight: 26 });

  for (const s of memo.subjects) {
    y = drawRow(doc, y, [
      { w: snoW, text: s.sno, align: 'center' },
      { w: nameW, text: s.name },
      { w: markW, text: s.internal, align: 'center' },
      { w: markW, text: s.external, align: 'center' },
      { w: markW, text: s.total, align: 'center' },
      { w: resultW, text: s.result, align: 'center' }
    ], { size: 9 });
  }
  y += 26;

  if (y + 20 > PAGE_H - 50) { doc.addPage(); y = MARGIN; }
  doc.font(REGULAR).fontSize(8.5).fillColor('#000');
  doc.text(FOOTER_NOTE, MARGIN, y, { width: CONTENT_W });
}

// Resolves to a Buffer holding every memo for the student, one per page group,
// with "n/N" page numbers across the whole document.
function buildMemoPdf(memos) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 0, left: 0, right: 0, bottom: 0 },   // layout is positioned absolutely
      bufferPages: true,
      info: { Title: 'Marks Memo', Author: 'Centurion University', Subject: 'Electronically generated marks memo' }
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      memos.forEach((memo, i) => {
        if (i > 0) doc.addPage();
        if (memo.kind === 'reattempt') drawReattemptMemo(doc, memo);
        else drawSemesterMemo(doc, memo);
      });

      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.font(REGULAR).fontSize(8).fillColor('#000');
        doc.text((i + 1) + '/' + range.count, MARGIN, PAGE_H - 40, { width: CONTENT_W, align: 'right' });
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildMemoPdf };
