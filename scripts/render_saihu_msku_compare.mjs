// Run with the bundled Node runtime. output/node_modules must point to its packages.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2]);
const require = createRequire(path.join(root, 'package.json'));
const { Workbook, SpreadsheetFile } = await import(require.resolve('@oai/artifact-tool'));
const tables = JSON.parse(await fs.readFile(path.join(root, 'workbook-tables.json'), 'utf8'));
const wb = Workbook.create();
const col = n => {
  let text = '';
  for (n++; n; n = Math.floor((n-1)/26)) text = String.fromCharCode(65+(n-1)%26)+text;
  return text;
};
let index = 0;
for (const [name, table] of Object.entries(tables)) {
  const s = wb.worksheets.add(name);
  const last = table.rows.length + 4;
  const end = col(table.headers.length-1);
  s.showGridLines = false;
  s.getRange(`A1:${end}${last}`).format.font = {name:'Helvetica Neue',size:11,color:'#20242A'};
  s.getRange(`A1:${end}${last}`).format.rowHeight = 23;
  s.getRange(`A1:${end}${last}`).format.verticalAlignment = 'center';
  s.getRange(`A1:${end}${last}`).format.columnWidth = 19;
  s.getRange('A1').values = [[name === '概览' ? 'Amazon-YYH-US 数据对照' : name]];
  s.getRange('A1').format.font = {size:15,bold:true};
  s.getRange('A2').values = [['2026-09-05 采集；仅作对照验证，C/D 未计算。数量单位：件。']];
  s.getRange('A2').format.font = {size:10,color:'#59616D'};
  s.getRange(`A4:${end}4`).values = [table.headers];
  s.getRange(`A4:${end}4`).format = {fill:'#273A50',font:{bold:true,color:'#FFFFFF'},wrapText:true,rowHeight:42,verticalAlignment:'center',horizontalAlignment:'center'};
  if (table.rows.length) {
    // Explicit literal values prevent business text from becoming Excel formulas.
    const values = table.rows.map(row => row.map(x => typeof x === 'string' && /^[=+@]/.test(x) ? "'"+x : x));
    s.getRange(`A5:${end}${last}`).values = values;
    s.getRange(`A5:${end}${last}`).setNumberFormat('#,##0');
    if (name !== '概览') {
      s.getRange(`A5:B${last}`).setNumberFormat('@');
      s.getRange(`A1:A${last}`).format.columnWidth = 34;
      s.getRange(`B1:B${last}`).format.columnWidth = 17;
      s.freezePanes.freezeRows(4);
      s.freezePanes.freezeColumns(2);
    } else {
      s.getRange(`A1:A${last}`).format.columnWidth = 37;
      s.getRange(`A5:A${last}`).format.wrapText = true;
      s.getRange(`B1:B${last}`).format.columnWidth = 90;
      s.getRange(`B5:B${last}`).format.wrapText = true;
      s.getRange(`A5:B${last}`).format.rowHeight = 38;
    }
    s.tables.add(`A4:${end}${last}`,true,`CompareTable${++index}`);
    if (table.formulas === 'sales') {
      s.getRange(`F5:G${last}`).formulas = table.rows.map((_,i) => {
        const r=i+5;
        return [`=IF(OR(D${r}="",E${r}=""),"",E${r}-D${r})`,`=IF(OR(D${r}="",E${r}="",D${r}=0),"",F${r}/D${r})`];
      });
      s.getRange(`G5:G${last}`).setNumberFormat('0.0%');
    } else if (table.formulas === 'inventory') {
      // K=available L=transfer M=processing N=customer ... T=inTransit.
      s.getRange(`W5:X${last}`).formulas = table.rows.map((_,i) => {
        const r=i+5;
        return [`=IF(OR(F${r}="",M${r}="",N${r}=""),"",F${r}-M${r}-N${r})`,`=IF(OR(T${r}="",O${r}="",P${r}="",Q${r}=""),"",T${r}-O${r}-P${r}-Q${r})`];
      });
    } else if (table.formulas === 'replay') {
      s.getRange(`F5:F${last}`).formulas = table.rows.map((_,i) => {
        const r=i+5;return [`=IF(OR(D${r}="",E${r}=""),"",E${r}-D${r})`];
      });
      s.getRange(`O5:P${last}`).format.columnWidth=70;
      s.getRange(`O5:P${last}`).format.wrapText=true;
      s.getRange(`A5:P${last}`).format.rowHeight=110;
    }
    const lastText = s.getRange(`${end}5:${end}${last}`);
    lastText.format.columnWidth = name === '概览' ? 90 : /说明|原因|结果/.test(table.headers.at(-1)) ? 56 : 19;
    lastText.format.wrapText = true;
    if (name === '数据来源') {
      s.getRange(`A1:A${last}`).format.columnWidth=40;
      s.getRange(`D5:D${last}`).setNumberFormat('0.00');
      s.getRange(`E5:F${last}`).setNumberFormat('yyyy-mm-dd hh:mm:ss');
      s.getRange(`E1:F${last}`).format.columnWidth=26;
    }
    if (name === '库存口径核对') s.getRange(`A1:A${last}`).format.columnWidth=55;
  }
  console.log(name, 'rows', table.rows.length);
  const preview = await wb.render({sheetName:name,range:`A1:${col(Math.min(table.headers.length,8)-1)}${Math.min(last,name==='补货对照AB'?8:12)}`,scale:1.5,format:'png'});
  await fs.writeFile(path.join(root, `preview-${name}.png`),new Uint8Array(await preview.arrayBuffer()));
  if (name==='库存对照' || name==='补货对照AB') {
    const right=await wb.render({sheetName:name,range:name==='库存对照'?'K4:Y9':'I4:P7',scale:1.5,format:'png'});
    await fs.writeFile(path.join(root,`preview-${name}-right.png`),new Uint8Array(await right.arrayBuffer()));
  }
}
const check = await wb.inspect({kind:'table',range:'补货对照AB!A4:H10',include:'values,formulas',tableMaxRows:7,tableMaxCols:8,maxChars:2500});
console.log(check.ndjson);
const errors = await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',options:{useRegex:true,maxResults:30},summary:'formula errors'});
console.log(errors.ndjson);
await fs.writeFile(path.join(root,'workbook-verification.json'),JSON.stringify({inspection:check.ndjson,errors:errors.ndjson}));
const file = await SpreadsheetFile.exportXlsx(wb);
await file.save(path.join(root,'数据对照.xlsx'));
console.log('Exported 数据对照.xlsx');
