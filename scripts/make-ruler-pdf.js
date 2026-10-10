// Generates public/ruler-sheet.pdf: a US Letter page with one large ArUco marker at an exact size.
// The layout must match RULER in public/detect.js.  Run: node scripts/make-ruler-pdf.js
const fs = require('node:fs');
const path = require('node:path');
const { AR } = require('../public/vendor/aruco.js');

const RULER = { id: 7, dict: 'ARUCO_MIP_36h12', x: 0.75, y: 0.75, side: 7 };
const PT = 72; // points per inch
const PAGE_H = 11 * PT;

const dict = new AR.Dictionary(RULER.dict);
const code = dict.codeList[RULER.id];
const cells = dict.markSize; // black border + data cells
const data = cells - 2;
const cell = (RULER.side * PT) / cells;

// PDF y runs up from the bottom; these helpers take inches from the top-left.
const rect = (x, y, w, h) => `${(x * PT).toFixed(2)} ${(PAGE_H - (y + h) * PT).toFixed(2)} ${(w * PT).toFixed(2)} ${(h * PT).toFixed(2)} re f`;
const text = (font, size, x, y, s) => `BT /${font} ${size} Tf ${(x * PT).toFixed(2)} ${(PAGE_H - y * PT).toFixed(2)} Td (${s.replace(/[()\\]/g, '\\$&')}) Tj ET`;

const ops = ['0 g', rect(RULER.x, RULER.y, RULER.side, RULER.side), '1 g'];
for (let cy = 0; cy < data; cy++) {
  for (let cx = 0; cx < data; cx++) {
    if (code[cy * data + cx] === '1') {
      ops.push(`${((RULER.x * PT) + (cx + 1) * cell).toFixed(2)} ${(PAGE_H - RULER.y * PT - (cy + 2) * cell).toFixed(2)} ${cell.toFixed(2)} ${cell.toFixed(2)} re f`);
    }
  }
}
ops.push('0 g');
const top = RULER.y + RULER.side;
ops.push(text('F2', 15, 0.75, top + 0.5, 'Gallery Wall Maker  -  ruler sheet'));
ops.push(text('F1', 11, 0.75, top + 0.85, '1. Print at Actual Size / 100% if your printer asks (the app double-checks using the paper edges).'));
ops.push(text('F1', 11, 0.75, top + 1.1, '2. Tape it flat on the wall, any way up, somewhere it is not covered.'));
ops.push(text('F1', 11, 0.75, top + 1.35, '3. Take your wall photo with the whole sheet in view.'));
// 6-inch check bar with inch ticks.
const barY = top + 1.75;
ops.push(rect(1.25, barY, 6, 0.08));
for (let i = 0; i <= 6; i++) ops.push(rect(1.25 + i - 0.01 - (i === 6 ? 0.01 : 0), barY - 0.12, 0.02, 0.2));
ops.push(text('F1', 9, 1.25, barY + 0.35, 'Check: this bar is 6 inches (15.24 cm) when printed at actual size.'));
const stream = ops.join('\n');

const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
];
let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const out = path.join(__dirname, '..', 'public', 'ruler-sheet.pdf');
fs.writeFileSync(out, pdf);
console.log(`wrote ${out} (${cells}x${cells} cells, ${(cell / PT).toFixed(3)} in each)`);
