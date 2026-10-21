// Regression: a stalled response body must not pin all engine readers forever.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const {once} = require('node:events');
const {test} = require('node:test');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = vm.createContext({fetch,Request,Response,Headers,URL,ReadableStream,AbortController,
    // Keep the real HTTP/body behavior; shorten only the adapter's idle deadline.
    setTimeout: (fn,ms)=>setTimeout(fn,Math.min(ms,100)), clearTimeout,
    location:{href:origin+'/',origin},
    GAME_CHUNKS:{chunkSize:8,files:{'/data/test.rpf':{size:8,prefix:'/chunks',type:'application/octet-stream'}}}});
  vm.runInContext(fs.readFileSync('hosting/chunk-fetch.js','utf8'),context);
  return context.fetch;
}
const expected = Buffer.from('12345678');

test('recovers from a stalled body and shares the retry between readers', {timeout:3000}, async t=>{
  let calls=0;
  const read=await fixture(t,(req,res)=>{
    calls++;
    if(calls===1){res.writeHead(200);res.write('1234');return;}
    res.end(expected);
  });
  const results=await Promise.all([0,4].map(async offset=>{
    const r=await read('/data/test.rpf',{headers:{Range:`bytes=${offset}-${offset+3}`}});
    return Buffer.from(await r.arrayBuffer());
  }));
  assert.deepEqual(results,[expected.subarray(0,4),expected.subarray(4)]);
  assert.equal(calls,2,'Both blocked readers must share one retried transfer');
});

test('persistent stalls reject with an asset path, then permit a new request', {timeout:3000}, async t=>{
  let calls=0, healthy=false;
  const read=await fixture(t,(req,res)=>{calls++;if(healthy)res.end(expected);});
  await assert.rejects(async()=> (await read('/data/test.rpf')).arrayBuffer(), /chunks\/0000\.bin.*3 attempts/);
  assert.equal(calls,3,'Unresponsive transport must have a finite retry budget');
  healthy=true;
  assert.deepEqual(Buffer.from(await (await read('/data/test.rpf')).arrayBuffer()),expected);
  assert.equal(calls,4,'A failed transfer must leave the pending map');
});

test('slow continuous downloads are allowed and cancelled readers do not cancel others', {timeout:3000}, async t=>{
  let calls=0;
  const read=await fixture(t,(req,res)=>{
    calls++;res.writeHead(200);let i=0;
    const timer=setInterval(()=>{res.write(expected.subarray(i,i+1));if(++i===expected.length){clearInterval(timer);res.end();}},40);
    res.on('close',()=>clearInterval(timer));
  });
  const abort=new AbortController();
  const cancelled=read('/data/test.rpf',{signal:abort.signal});
  const survivor=read('/data/test.rpf');
  const rejected=assert.rejects(cancelled,e=>e.name==='AbortError');
  setTimeout(()=>abort.abort(),50);
  await rejected;
  assert.deepEqual(Buffer.from(await (await survivor).arrayBuffer()),expected);
  assert.equal(calls,1,'Progress must extend the idle deadline and preserve the shared transfer');
});

test('a truncated cached piece is refetched without trusting the cache again', {timeout:3000}, async t=>{
  let calls=0;const controls=[];
  const read=await fixture(t,(req,res)=>{controls.push(req.headers['cache-control']);res.end(++calls===1?'bad':expected);});
  assert.deepEqual(Buffer.from(await (await read('/data/test.rpf')).arrayBuffer()),expected);
  assert.equal(calls,2);
  assert.match(controls[1],/no-cache/);
});

test('a socket reset during a body is retried without returning partial bytes', {timeout:3000}, async t=>{
  let calls=0;
  const read=await fixture(t,(req,res)=>{
    if(++calls===1){res.writeHead(200);res.write('1234');setTimeout(()=>res.destroy(),20);}
    else res.end(expected);
  });
  assert.deepEqual(Buffer.from(await (await read('/data/test.rpf')).arrayBuffer()),expected);
  assert.equal(calls,2);
});

test('an HTTP error gets one cache-bypassing attempt before caller retry handling', {timeout:3000}, async t=>{
  let calls=0; const controls=[];
  const read=await fixture(t,(req,res)=>{
    controls.push(req.headers['cache-control']); calls++;
    if(calls===1){res.writeHead(502,{'Cache-Control':'public, max-age=600'});res.end('temporary failure');}
    else res.end(expected);
  });
  const response=await read('/data/test.rpf');
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
  assert.equal(calls,2);
  assert.match(controls[1],/no-cache/);
});
