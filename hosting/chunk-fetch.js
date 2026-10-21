/* Serve byte ranges from small immutable static files. Pages may ignore Range.
 * Whole pieces use the browser HTTP cache; bounded RAM and shared pending
 * requests avoid downloading the same piece for concurrent engine reads.
 * Range reads retain a sufficient prefix and cancel the unused tail.
 */
(() => {
  'use strict';
  const originalFetch = globalThis.fetch.bind(globalThis);
  const manifest = globalThis.GAME_CHUNKS;
  const cache = new Map(), pending = new Map(), budget = 32 * 1024 * 1024;
  const idleTimeout = 30000, attempts = 3, prefixSize = 64 * 1024;
  let cacheBytes = 0;
  async function downloadPiece(url, size, options, prefixBytes) {
    const wanted = prefixBytes || size;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      let timer, reader;
      const progress = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error('No chunk data received for 30 seconds')), idleTimeout);
      };
      try {
        progress();
        // A retry must not keep returning a truncated response from the HTTP cache.
        const res = await originalFetch(url, {cache: attempt ? 'reload' : 'force-cache', priority: options.priority, signal: controller.signal});
        if (!res.ok) {
          await res.body?.cancel();
          // force-cache can retain a temporary error across every caller retry.
          // Check the server once before preserving its HTTP failure response.
          if (attempt === 0) continue;
          return {failure: {status: res.status, statusText: res.statusText}};
        }
        if (res.status !== 200) { await res.body?.cancel(); throw new Error(`Unexpected chunk status ${res.status}`); }
        const bytes = new Uint8Array(wanted);
        let received = 0;
        reader = res.body.getReader();
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          if (!value.byteLength) continue;
          progress();
          if (!prefixBytes && received + value.byteLength > size) throw new Error(`Truncated or invalid game chunk: expected ${size}, received more bytes`);
          const take = Math.min(value.byteLength, wanted - received);
          bytes.set(value.subarray(0, take), received); received += take;
          if (prefixBytes && received === wanted) {
            // Stop after the requested window, rounded to 64 KiB, even when
            // the static host ignores Range. Never cache it as a full piece.
            reader.cancel().catch(() => {});
            controller.abort();
            return {bytes};
          }
        }
        if (received !== wanted) throw new Error(`Truncated or invalid game chunk: expected ${wanted}, received ${received}`);
        return {bytes};
      } catch (error) {
        lastError = error;
        controller.abort(error);
        reader?.cancel().catch(() => {});
      } finally { clearTimeout(timer); }
    }
    throw new Error(`Game chunk ${url.pathname} failed after ${attempts} attempts: ${lastError?.message || lastError}`);
  }
  async function piece(url, size, options, prefixBytes) {
    const fullKey = url.href, prefixKey = fullKey + '#prefix';
    // A complete piece can satisfy either kind of read, never the reverse.
    const cachedKey = cache.has(fullKey) ? fullKey : prefixKey;
    const cached = cache.get(cachedKey);
    if (cached && (cachedKey === fullKey || (prefixBytes && cached.length >= prefixBytes))) {
      const bytes = cached; cache.delete(cachedKey); cache.set(cachedKey, bytes);
      return {bytes};
    }
    const key = prefixBytes ? prefixKey : fullKey;
    const jobKey = prefixBytes ? `${prefixKey}:${prefixBytes}` : fullKey;
    if (pending.has(jobKey)) return pending.get(jobKey);
    const job = (async () => {
      // At most 4 MiB per transfer. A reader must not abort another reader's shared transfer.
      const result = await downloadPiece(url, size, options, prefixBytes);
      if (result.failure) return result;
      const {bytes} = result;
      // A late smaller request must not replace a newer, more complete cache.
      if (prefixBytes && (cache.has(fullKey) || (cache.get(prefixKey)?.length || 0) >= bytes.length)) return result;
      if (!prefixBytes && cache.has(prefixKey)) {
        cacheBytes -= cache.get(prefixKey).byteLength; cache.delete(prefixKey);
      }
      if (cache.has(key)) { cacheBytes -= cache.get(key).byteLength; cache.delete(key); }
      while (cacheBytes + bytes.length > budget && cache.size) {
        const oldest = cache.keys().next().value;
        cacheBytes -= cache.get(oldest).byteLength; cache.delete(oldest);
      }
      if (bytes.length <= budget) { cache.set(key, bytes); cacheBytes += bytes.length; }
      return {bytes};
    })();
    pending.set(jobKey, job);
    try { return await job; } finally { pending.delete(jobKey); }
  }
  function waitForPiece(job, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, {once: true});
      job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  globalThis.fetch = async (input, options = {}) => {
    const request = new Request(input instanceof Request ? input : new URL(input, location.href), options);
    const url = new URL(request.url);
    if (url.origin !== location.origin) return originalFetch(input, options);
    let path;
    // Engine paths encode each filename, including @. decodeURI leaves %40
    // encoded and misses archives that exist only as pieces in the manifest.
    try { path = decodeURIComponent(url.pathname); }
    catch { return originalFetch(input, options); }
    const file = manifest.files[path];
    if (!file || !['GET', 'HEAD'].includes(request.method)) return originalFetch(input, options);
    request.signal.throwIfAborted();
    const size = file.size, step = file.url ? size : manifest.chunkSize;
    let start = 0, end = size - 1;
    const range = request.headers.get('Range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}});
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}});
      }
    }
    const headers = new Headers({'Content-Type': file.type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes'});
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    const responseInit = {status: range ? 206 : 200, headers};
    if (request.method === 'HEAD' || !size) return new Response(null, responseInit);
    let position = start, cancelled = false;
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', onAbort, {once: true});
    const cleanup = () => request.signal.removeEventListener('abort', onAbort);
    async function next() {
      controller.signal.throwIfAborted();
      const index = Math.floor(position / step);
      const pieceURL = new URL(file.url ? file.url + url.search : `${file.prefix}/${String(index).padStart(4, '0')}.bin`, location.origin);
      const partSize = Math.min(step, size - index * step);
      const needed = Math.min(partSize, end - index * step + 1);
      const rounded = Math.min(partSize, Math.ceil(needed / prefixSize) * prefixSize);
      const prefixBytes = range && rounded < partSize ? rounded : 0;
      return waitForPiece(piece(pieceURL, partSize, options, prefixBytes), controller.signal);
    }
    let ready;
    try { ready = await next(); if (ready.failure) { cleanup(); return new Response(null, ready.failure); } }
    catch (error) { cleanup(); throw error; }
    return new Response(new ReadableStream({
      async pull(stream) {
        try {
          const result = ready || await next(); ready = null;
          if (cancelled) return;
          controller.signal.throwIfAborted();
          if (result.failure) throw new Error(`Chunk HTTP ${result.failure.status}`);
          const offset = position % step;
          const bytes = result.bytes.subarray(offset, Math.min(result.bytes.length, offset + end - position + 1));
          position += bytes.length;
          stream.enqueue(bytes);
          if (position > end) { cleanup(); stream.close(); }
        } catch (error) { cleanup(); if (!cancelled) stream.error(error); }
      },
      cancel(reason) { cancelled = true; cleanup(); controller.abort(reason); }
    }, {highWaterMark: 0}), responseInit);
  };
})();
