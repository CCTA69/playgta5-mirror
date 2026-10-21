// Manual Chromium regression: node tests/browser_cache_fixture.cjs, then /test.
// Uses only local fixture bytes; no game download or unrelated cache clearing.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const counts = new Map();
http.createServer((req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4186');
  const key = url.searchParams.get('case');
  if (url.pathname === '/probe.bin') {
    const n = (counts.get(key) || 0) + 1; counts.set(key,n);
    res.writeHead(n === 1 ? 502 : 200, {'Content-Type':'application/octet-stream','Cache-Control':'public, max-age=600'});
    res.end(n === 1 ? 'temporary failure' : '12345678'); return;
  }
  if (url.pathname === '/count') {res.writeHead(200,{'Cache-Control':'no-store'});res.end(String(counts.get(key)||0));return;}
  if (url.pathname === '/adapter.js') {res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,'../hosting/chunk-fetch.js')));return;}
  if (url.pathname !== '/test') {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  res.end(`<!doctype html><title>Cached error regression</title><h1>Cached error regression</h1><pre id="result">Running...</pre><script type="module">
const output=document.querySelector('#result'), nativeFetch=fetch.bind(globalThis), key=crypto.randomUUID();
try {
 const first=await nativeFetch('/probe.bin?case='+key,{cache:'force-cache'}); await first.arrayBuffer();
 globalThis.GAME_CHUNKS={chunkSize:8,files:{'/data/test.rpf':{size:8,url:'/probe.bin?case='+key,type:'application/octet-stream'}}};
 await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/adapter.js';s.onload=resolve;s.onerror=reject;document.head.append(s);});
 const response=await fetch('/data/test.rpf',{headers:{Range:'bytes=0-3'}}), body=await response.text();
 const requests=await(await nativeFetch('/count?case='+key,{cache:'no-store'})).text();
 output.textContent=(response.status===206&&body==='1234'&&requests==='2'?'PASS':'FAIL')+' — primed HTTP '+first.status+', loader HTTP '+response.status+', bytes '+JSON.stringify(body)+', network requests '+requests;
} catch(e){output.textContent='FAIL — '+e.message;}
</script>`);
}).listen(4186,'127.0.0.1',()=>console.log('Cached-error regression: http://127.0.0.1:4186/test'));
