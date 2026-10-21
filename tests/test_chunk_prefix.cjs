const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const {once} = require('node:events');
const {test} = require('node:test');
const data = Buffer.from(Array.from({length: 512 * 1024}, (_, i) => i % 251));

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = vm.createContext({fetch, Request, Response, Headers, URL, ReadableStream, AbortController, setTimeout, clearTimeout,
    location: {href: origin + '/', origin}, GAME_CHUNKS: {chunkSize: data.length, files: {
      '/data/archive.rpf': {size: data.length, prefix: '/chunks', type: 'application/octet-stream'},
      '/data/two-pieces.rpf': {size: data.length * 2, prefix: '/chunks', type: 'application/octet-stream'},
      '/data/small.rpf': {size: data.length, url: '/raw.rpf', type: 'application/octet-stream'}
    }}});
  vm.runInContext(fs.readFileSync('hosting/chunk-fetch.js', 'utf8'), context);
  return async (path, range) => {
    const response = await context.fetch(path, {headers: range ? {Range: range} : {}});
    assert.equal(response.status, range ? 206 : 200);
    return Buffer.from(await response.arrayBuffer());
  };
}

for (const path of ['/data/archive.rpf', '/data/small.rpf']) {
  test(`header reads cancel the unused body and never masquerade as a complete file: ${path}`, {timeout:5000}, async t => {
    const transfers = [];
    let closeFirst;
    const firstClosed = new Promise(resolve => {closeFirst = resolve;});
    const read = await fixture(t, (req,res) => {
      assert.equal(req.headers.range, undefined, 'The static host need not honor Range');
      const transfer = {sent: 65536}; transfers.push(transfer);
      res.writeHead(200, {'Content-Length': data.length});
      res.write(data.subarray(0, transfer.sent));
      const timer = setInterval(() => {
        const end = Math.min(data.length, transfer.sent + 16384);
        res.write(data.subarray(transfer.sent, end)); transfer.sent = end;
        if (end === data.length) res.end();
      }, 10);
      res.on('close', () => {clearInterval(timer); if (transfers[0] === transfer) closeFirst();});
    });
    const headers = await Promise.all([read(path, 'bytes=0-15'), read(path, 'bytes=32-63')]);
    assert.deepEqual(headers, [data.subarray(0,16), data.subarray(32,64)]);
    await firstClosed;
    assert.equal(transfers.length, 1, 'Concurrent header reads share a prefix');
    assert.ok(transfers[0].sent < data.length / 2, 'A 16-byte header must not download the whole archive');
    assert.deepEqual(await read(path, 'bytes=1024-2047'), data.subarray(1024,2048));
    assert.equal(transfers.length, 1, 'Nearby header reads reuse the prefix');
    assert.deepEqual(await read(path, 'bytes=65528-65543'), data.subarray(65528,65544));
    assert.equal(transfers.length, 2, 'A read beyond the prefix extends the cached prefix');
    assert.deepEqual(await read(path), data);
    assert.deepEqual(await read(path, 'bytes=0-15'), data.subarray(0,16));
    assert.equal(transfers.length, 3, 'Only the full-file read needs the complete piece');
  });
}

for (const path of ['/data/archive.rpf', '/data/small.rpf']) {
  test(`small middle reads stop after their window and reuse larger prefixes: ${path}`, {timeout:5000}, async t => {
    const transfers = [];
    const read = await fixture(t, (_req,res) => {
      let done;
      const transfer={sent:0,closed:new Promise(resolve=>{done=resolve;})}; transfers.push(transfer);
      res.writeHead(200, {'Content-Length':data.length});
      const timer=setInterval(()=>{
        const end=Math.min(data.length,transfer.sent+16384);
        res.write(data.subarray(transfer.sent,end)); transfer.sent=end;
        if(end===data.length)res.end();
      },5);
      res.on('close',()=>{clearInterval(timer);done();});
    });
    assert.deepEqual(await read(path,'bytes=0-15'),data.subarray(0,16));
    assert.deepEqual(await read(path,'bytes=180000-180031'),data.subarray(180000,180032));
    await transfers[1].closed;
    assert.ok(transfers[1].sent<300000,'A middle read must not download the whole 512 KiB piece');
    assert.deepEqual(await read(path,'bytes=100000-100015'),data.subarray(100000,100016));
    assert.equal(transfers.length,2,'A larger prefix also serves earlier ranges');
    assert.deepEqual(await read(path,'bytes=260000-260015'),data.subarray(260000,260016));
    assert.equal(transfers.length,3);
    assert.deepEqual(await read(path),data);
    assert.equal(transfers.length,4,'An extended prefix is still not a complete file');
  });
}

test('a late smaller prefix does not replace a larger cached prefix', {timeout:5000}, async t => {
  let firstResponse, announce, calls=0;
  const firstStarted=new Promise(resolve=>{announce=resolve;});
  const read=await fixture(t,(_req,res)=>{
    calls++;
    if(calls===1){firstResponse=res;res.write(data.subarray(0,32768));announce();}
    else res.end(data);
  });
  const small=read('/data/archive.rpf','bytes=0-15');
  await firstStarted;
  assert.deepEqual(await read('/data/archive.rpf','bytes=180000-180015'),data.subarray(180000,180016));
  firstResponse.end(data.subarray(32768));
  assert.deepEqual(await small,data.subarray(0,16));
  assert.deepEqual(await read('/data/archive.rpf','bytes=100000-100015'),data.subarray(100000,100016));
  assert.equal(calls,2);
});

test('a body shorter than the prefix is retried and never cached', {timeout:5000}, async t => {
  let calls = 0;
  const read = await fixture(t, (_req,res) => {calls++; res.end(data.subarray(0,32768));});
  await assert.rejects(read('/data/archive.rpf', 'bytes=0-15'), /3 attempts.*Truncated/);
  assert.equal(calls, 3);
});

test('a cross-piece read combines a complete piece with the next prefix', {timeout:5000}, async t => {
  const second = Buffer.from(data).reverse(), calls = [];
  const read = await fixture(t, (req,res) => {
    calls.push(req.url); res.end(req.url.endsWith('/0001.bin') ? second : data);
  });
  assert.deepEqual(await read('/data/two-pieces.rpf', `bytes=${data.length-8}-${data.length+15}`),
    Buffer.concat([data.subarray(-8), second.subarray(0,16)]));
  assert.deepEqual(calls, ['/chunks/0000.bin', '/chunks/0001.bin']);
});

test('a header can finish while a separate full transfer is still pending', {timeout:5000}, async t => {
  let firstResponse, announce, calls = 0;
  const firstStarted = new Promise(resolve => {announce = resolve;});
  const read = await fixture(t, (_req,res) => {
    calls++;
    if (calls === 1) {firstResponse = res; res.write(data.subarray(0,65536)); announce();}
    else res.end(data);
  });
  const full = read('/data/archive.rpf');
  await firstStarted;
  assert.deepEqual(await read('/data/archive.rpf', 'bytes=0-15'), data.subarray(0,16));
  assert.equal(calls, 2, 'The header must not wait for a bulk transfer');
  firstResponse.end(data.subarray(65536));
  assert.deepEqual(await full, data, 'Cancelling the prefix must not cancel the full transfer');
  assert.deepEqual(await read('/data/archive.rpf'), data);
  assert.equal(calls, 2);
});
