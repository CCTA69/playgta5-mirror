// Runs the actual archived I/O worker through the Pages patch and chunk adapter.
// PAGES_IO_REFERENCE overrides the archive location. PAGES_IO_WORKER instead
// supplies an already-generated worker (or the unpatched archive for a red run).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {test} = require('node:test');

const root = path.resolve(__dirname, '..');
const reference = process.env.PAGES_IO_REFERENCE || path.resolve(root, '../gta5-runtime-reference/io_worker.js');
const source = process.env.PAGES_IO_WORKER
  ? fs.readFileSync(process.env.PAGES_IO_WORKER, 'utf8')
  : execFileSync(process.env.PYTHON || 'python', ['-B', '-X', 'utf8', '-c', [
    'from pathlib import Path',
    'import sys',
    'sys.path.insert(0, sys.argv[1])',
    'from build_pages import patch_pages_io',
    "print(patch_pages_io(Path(sys.argv[2]).read_text(encoding='utf-8')), end='')",
  ].join('\n'), root, reference], {encoding: 'utf8', timeout: 10000});
const adapter = fs.readFileSync(path.join(root, 'hosting/chunk-fetch.js'), 'utf8');
const pieceSize = 4 * 1024 * 1024;
const data = Uint8Array.from({length: pieceSize}, (_, i) => i % 251);

async function coldRead(first, last) {
  const transfers = [];
  const stored = new Uint8Array((last - first + 1) * 4096);
  // Deterministic streaming transport: counts every byte consumed below the
  // adapter, including prefix bytes that the I/O worker never receives.
  const fetch = async input => {
    assert.equal(new URL(input).pathname, '/pieces/0000.bin');
    const transfer = {bytes: 0};
    transfers.push(transfer);
    return new Response(new ReadableStream({
      pull(controller) {
        if (transfer.bytes === pieceSize) { controller.close(); return; }
        const end = Math.min(pieceSize, transfer.bytes + 65536);
        controller.enqueue(data.subarray(transfer.bytes, end));
        transfer.bytes = end;
      },
    }, {highWaterMark: 0}), {headers: {'Content-Length': String(pieceSize)}});
  };
  const context = vm.createContext({
    fetch, Request, Response, Headers, URL, ReadableStream, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, performance, console,
    Uint8Array, Int32Array, DataView, ArrayBuffer, Map, Set, Math, Promise, Atomics,
    TextEncoder, crypto: require('node:crypto').webcrypto,
    importScripts() {},
    BroadcastChannel: class { postMessage() {} },
    self: {postMessage() {}},
    location: {href: 'https://fixture.test/b/test/io_worker.js', origin: 'https://fixture.test'},
    GAME_CHUNKS: {chunkSize: pieceSize, files: {
      '/data/test.rpf': {size: pieceSize, prefix: '/pieces', type: 'application/octet-stream'},
    }},
    writeBytes(chunk, at) { stored.set(chunk, at); return chunk.length; },
  });
  vm.runInContext(source, context);
  vm.runInContext(adapter, context);
  // Only platform I/O is substituted; ensureBlocks, fetchRange, cache lookup,
  // prefix downloads, and response slicing are the production implementations.
  await vm.runInContext(`
    files = [{path: 'test.rpf', size: ${pieceSize}}];
    base = 'https://fixture.test/data/';
    bc = {postMessage() {}};
    sh = {write(chunk, options) { return writeBytes(chunk, options.at); }};
    ensureBlocks(0, ${first}, ${last}, false);
  `, context);
  assert.deepEqual(stored, data.subarray(first * 4096, (last + 1) * 4096));
  return {requests: transfers.length, networkBytes: transfers.reduce((sum, item) => sum + item.bytes, 0)};
}

test('a cold 1 MiB demand at 3 MiB downloads its 4 MiB piece only once', {timeout: 10000}, async t => {
  const result = await coldRead(768, 1023);
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.requests, 1, 'Parallel I/O slices must not download overlapping prefixes');
  assert.ok(result.networkBytes <= pieceSize, 'One demand run must consume at most one complete piece');
});

test('a single cold 4 KiB demand keeps its existing bounded prefix', {timeout: 10000}, async t => {
  const result = await coldRead(768, 768);
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.requests, 1);
  assert.equal(result.networkBytes, 3 * 1024 * 1024 + 65536,
    'Disabling I/O slicing must not turn a tiny demand into a full-piece download');
});

