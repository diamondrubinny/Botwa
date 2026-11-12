const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
(async () => {
  const [src, dst] = process.argv.slice(2); const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.svg')).sort()) {
    await p.setContent(`<html><body style="margin:0">${fs.readFileSync(path.join(src, f), 'utf8')}</body></html>`);
    await p.locator('svg').screenshot({ path: path.join(dst, f.replace('.svg', '.png')), omitBackground: false });
  }
  // a contact sheet to look at all of them at once
  const imgs = fs.readdirSync(dst).filter((x) => x.endsWith('.png') && /^p\d\d/.test(x)).sort().map((f) => `<img src="data:image/png;base64,${fs.readFileSync(path.join(dst, f)).toString('base64')}" style="width:128px;height:128px;border-radius:50%;margin:6px">`).join('');
  const q = await b.newPage({ viewport: { width: 860, height: 600 } }); await q.setContent(`<body style="margin:10px;background:#f7f5ff">${imgs}</body>`);
  await q.screenshot({ path: path.join(dst, 'sheet.png'), fullPage: true });
  await b.close();
})();
