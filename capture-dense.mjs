import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const chromePath = CHROME_PATHS.find(p => fs.existsSync(p));
const PORT = 8095;
const DEBUG_PORT = 9228;

const serverProc = spawn('node', ['server.js'], {
  cwd: 'c:\\Users\\Karol\\.gemini\\antigravity\\scratch\\DarkPDF & Calc\\darkpdf',
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore'
});

await new Promise(r => setTimeout(r, 600));

const chromeProc = spawn(chromePath, [
  '--headless',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--disable-gpu',
  '--window-size=1280,800',
  `http://localhost:${PORT}/darkpdf/`
], { stdio: 'ignore' });

try {
  await new Promise(r => setTimeout(r, 1200));
  const tabsRes = await fetch(`http://localhost:${DEBUG_PORT}/json`);
  const tabs = await tabsRes.json();
  const tab = tabs.find(t => t.url.includes('darkpdf'));

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let idCounter = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = idCounter++;
    const handler = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id === id) {
        ws.removeEventListener('message', handler);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // Let's create a PDF with 2 dense pages of lines spanning a big area
  let p1Lines = '';
  for (let y = 100; y <= 350; y += 15) {
    p1Lines += `50 ${y} Td (This is line of text on page 1 covering content) Tj -50 0 Td `;
  }
  let p2Lines = '';
  for (let y = 100; y <= 350; y += 15) {
    p2Lines += `50 ${y} Td (This is line of text on page 2 covering content) Tj -50 0 Td `;
  }

  const s1 = `BT /F1 10 Tf ${p1Lines} ET`;
  const s2 = `BT /F1 10 Tf ${p2Lines} ET`;

  const pdfData = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 2/Kids[3 0 R 5 0 R]>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 300 400]/Parent 2 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>/Contents 4 0 R>>endobj
4 0 obj<</Length ${s1.length}>>stream
${s1}
endstream
endobj
5 0 obj<</Type/Page/MediaBox[0 0 300 400]/Parent 2 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>/Contents 6 0 R>>endobj
6 0 obj<</Length ${s2.length}>>stream
${s2}
endstream
endobj
xref
0 7
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000115 00000 n 
0000000257 00000 n 
0000000000 00000 n 
0000000000 00000 n 
trailer<</Size 7/Root 1 0 R>>
startxref
500
%%EOF`;

  const pdfScript = `(async () => {
    const raw = ${JSON.stringify(pdfData)};
    const bytes = new TextEncoder().encode(raw);
    const file = new File([bytes], 'dense.pdf', { type: 'application/pdf' });
    const { openLocal } = await import('./doc-loader.js');
    await openLocal(file);
    await new Promise(r => setTimeout(r, 1000));

    return {
      pages: document.querySelectorAll('#stage .page').length,
      crop: document.querySelector('#stage canvas')?.width
    };
  })()`;

  const loadRes = await send('Runtime.evaluate', {
    expression: pdfScript,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('Loaded dense:', loadRes.result.value);

  // Take screenshot in light mode
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    })()`
  });
  await new Promise(r => setTimeout(r, 400));

  const shotLight = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('c:\\Users\\Karol\\.gemini\\antigravity\\scratch\\DarkPDF & Calc\\darkpdf\\shot-dense-light.png', Buffer.from(shotLight.data, 'base64'));

  // Also dark mode
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    })()`
  });
  await new Promise(r => setTimeout(r, 400));
  const shotDark = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('c:\\Users\\Karol\\.gemini\\antigravity\\scratch\\DarkPDF & Calc\\darkpdf\\shot-dense-dark.png', Buffer.from(shotDark.data, 'base64'));

  ws.close();
} finally {
  chromeProc.kill();
  serverProc.kill();
}
