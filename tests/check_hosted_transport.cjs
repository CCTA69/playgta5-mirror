// Network smoke test, not a gameplay test. Run with Node 24+ after deployment.
// Optional third argument is a DNS-verified IP for diagnosing local resolver failures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const https = require('node:https');
const {Readable} = require('node:stream');
const {createHash} = require('node:crypto');
const origin = new URL(process.argv[2]).origin;
const ip = process.argv[3];
function networkFetch(input) {
  const url = new URL(input);
  assert.equal(url.origin, origin);
  return new Promise((resolve, reject) => {
    const options = ip ? {lookup: (_name, opts, cb) => opts.all ? cb(null, [{address: ip, family: 4}]) : cb(null, ip, 4)} : {};
    const req = https.get(url, options, res => resolve(new Response(Readable.toWeb(res), {status: res.statusCode, headers: res.headers})));
    req.setTimeout(60000, () => req.destroy(new Error('HTTPS request timed out')));
    req.on('error', reject);
  });
}
(async () => {
  const page = await networkFetch(origin + '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(page.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  await page.body.cancel();
  const manifestResponse = await networkFetch(origin + '/chunk-index.js');
  assert.equal(manifestResponse.status, 200);
  const manifest = JSON.parse((await manifestResponse.text()).replace(/^globalThis.GAME_CHUNKS=/, '').trim().replace(/;$/, ''));
  const codeResponse = await networkFetch(origin + '/chunk-fetch.js');
  const code = await codeResponse.text();
  assert.equal(code.replace(/\r\n/g, '\n'), fs.readFileSync('hosting/chunk-fetch.js', 'utf8').replace(/\r\n/g, '\n'));
  const context = vm.createContext({fetch: networkFetch, Request, Response, Headers, URL, ReadableStream, AbortController,
    location: {href: origin + '/', origin}, GAME_CHUNKS: manifest});
  vm.runInContext(code, context);
  const wasmPath = Object.keys(manifest.files).find(path => path.endsWith('/game.wasm'));
  const original = fs.readFileSync('mirror/playgta5.com' + wasmPath);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const [start, end] of [[0, 3], [manifest.chunkSize - 37, manifest.chunkSize + 57], [original.length - 10, original.length - 1]]) {
    const response = await context.fetch(wasmPath, {headers: {Range: `bytes=${start}-${end}`}});
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original.subarray(start, end + 1));
  }
  console.log('PASS: HTTPS isolation headers and real hosted cross-piece byte ranges');
  const bytes = Buffer.from(await (await context.fetch(wasmPath)).arrayBuffer());
  assert.equal(hash(bytes), hash(original));
  console.log('PASS: complete hosted engine SHA-256 matches the release (' + bytes.length + ' bytes)');
  await WebAssembly.compileStreaming(context.fetch(wasmPath));
  console.log('PASS: reconstructed hosted engine compiles with streaming WebAssembly');
  const missing = await networkFetch(origin + '/missing-test-asset-not-in-release.bin');
  assert.equal(missing.status, 404); await missing.body.cancel();
  console.log('PASS: missing assets return 404 instead of the game HTML');
})().catch(error => { console.error(error); process.exitCode = 1; });
