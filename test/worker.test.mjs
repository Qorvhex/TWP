import test from 'node:test';
import assert from 'node:assert/strict';
import { getTwpInternals } from '../worker.js';

const {
  TELEGRAM_DCS,
  HELLO_FRAME_BYTES,
  WELCOME_FRAME_BYTES,
  FRAME_OPEN,
  FRAME_DATA,
  FRAME_WINDOW,
  FRAME_PONG,
  FRAME_BYE,
  toHex,
  parseHex,
  toBase64Url,
  fromBase64Url,
  concatArrays,
  reverseBytes,
  incrementCounter128,
  packFrame,
  packFrameBatch,
  unpackFrameBatch,
  validateClientFrame,
  createAesCtrCipher,
  applyAesCtr,
  resolveConfig,
  issueStatelessToken,
  verifyStatelessToken,
  normalizeDcId,
  parseClientHandshake,
  generateDcHandshake,
  connectToDatacenter,
  safeCloseSocket,
  handleHttpRequest,
} = getTwpInternals();

test('hex and base64url primitives roundtrip accurately', () => {
  const sample = new Uint8Array([0x00, 0x01, 0xdd, 0x70, 0xfe, 0xff, 0x10, 0x80]);
  const hex = toHex(sample);
  assert.equal(hex, '0001dd70feff1080');
  assert.deepEqual(parseHex(hex), sample);
  assert.deepEqual(parseHex(hex.toUpperCase()), sample);

  const b64 = toBase64Url(sample);
  assert.ok(!b64.includes('='));
  assert.deepEqual(fromBase64Url(b64), sample);
});

test('128-bit big-endian counter increments across 32-bit word boundaries', () => {
  const iv = new Uint8Array(16);
  iv[15] = 0xff;
  iv[14] = 0xff;
  iv[13] = 0xff;
  iv[12] = 0xff;
  const next = incrementCounter128(iv, 2);
  assert.equal(next[15], 1);
  assert.equal(next[14], 0);
  assert.equal(next[13], 0);
  assert.equal(next[12], 0);
  assert.equal(next[11], 1);
});

test('TELEGRAM_DCS contains valid endpoints and normalizes DC IDs', () => {
  assert.equal(TELEGRAM_DCS[2].includes('149.154.167.92'), true);
  assert.equal(TELEGRAM_DCS[4].includes('149.154.167.92'), true);

  assert.equal(normalizeDcId(2), 2);
  assert.equal(normalizeDcId(-4), -4);
  assert.equal(normalizeDcId(10003), 3);
  assert.equal(normalizeDcId(0), 2);
  assert.equal(normalizeDcId(99), null);
});

test('frame packing, batching, and validation adhere to tproxy v1 wire format', () => {
  assert.equal(HELLO_FRAME_BYTES.length, 9);
  assert.equal(WELCOME_FRAME_BYTES.length, 8);
  assert.equal(WELCOME_FRAME_BYTES[0], 0x11);
  assert.equal(WELCOME_FRAME_BYTES[1], 0);
  assert.equal(WELCOME_FRAME_BYTES[2], 0);
  assert.equal(WELCOME_FRAME_BYTES[3], 0);
  assert.equal(WELCOME_FRAME_BYTES[4], 0);
  assert.equal(WELCOME_FRAME_BYTES[5], 0);
  assert.equal(WELCOME_FRAME_BYTES[6], 0);
  assert.equal(WELCOME_FRAME_BYTES[7], 0);

  const f1 = packFrame(FRAME_OPEN, 7);
  const f2 = packFrame(FRAME_DATA, 7, new Uint8Array([1, 2, 3, 4]));
  const f3 = packFrame(FRAME_WINDOW, 7, new Uint8Array([0, 1, 0, 0]));
  const f4 = packFrame(FRAME_PONG, 0, new Uint8Array([9, 9]));
  const f5 = packFrame(FRAME_BYE, 0);

  const batch = packFrameBatch([f1, f2, f3, f4, f5]);
  const unpacked = unpackFrameBatch(batch);
  assert.equal(unpacked.length, 5);
  unpacked.forEach(validateClientFrame);
});

test('stateless token issuance and verification work end-to-end', async () => {
  const cfg = await resolveConfig({
    PROXY_SECRET: 'dd000102030405060708090a0b0c0d0e0f',
  });
  assert.ok(cfg);
  assert.equal(cfg.isPadded, true);

  const tok = await issueStatelessToken(cfg, 1, 1000);
  assert.equal(await verifyStatelessToken(cfg, tok, 1, 120, 1080), true);
  assert.equal(await verifyStatelessToken(cfg, tok, 1, 120, 1300), false);
  assert.equal(await verifyStatelessToken(cfg, tok, 2, 120, 1080), false);
});

test('Obfuscated2 client handshake parser and DC handshake preserve zero-copy downlink invariant', async () => {
  const secretHex = '000102030405060708090a0b0c0d0e0f';
  const cfg = await resolveConfig({ PROXY_SECRET: secretHex });

  const clientPlainInit = new Uint8Array(64);
  crypto.getRandomValues(clientPlainInit);
  clientPlainInit[0] = 0xaa;
  const view = new DataView(clientPlainInit.buffer);
  view.setUint32(56, 0xdddddddd);
  view.setInt16(60, 2, true);

  const clientUpKey = new Uint8Array(
    await crypto.subtle.digest('SHA-256', concatArrays(clientPlainInit.subarray(8, 40), cfg.secret16))
  );
  const clientUpIv = clientPlainInit.slice(40, 56);
  const clientUpCipher = await createAesCtrCipher(clientUpKey, clientUpIv);
  const encryptedInit = await applyAesCtr(clientUpCipher, 0, clientPlainInit);

  const clientWireInit = clientPlainInit.slice();
  clientWireInit.set(encryptedInit.subarray(56, 64), 56);

  const parsed = await parseClientHandshake(cfg, clientWireInit);
  assert.equal(parsed.transportTag, 0xdddddddd);
  assert.equal(parsed.datacenterId, 2);

  const dcHs = await generateDcHandshake(parsed);
  assert.equal(dcHs.wirePayload.length, 64);

  const dcDownSource = reverseBytes(dcHs.wirePayload.subarray(8, 56));
  assert.deepEqual(dcDownSource.subarray(0, 32), parsed.clientDownKey);
  assert.deepEqual(dcDownSource.subarray(32, 48), parsed.clientDownIv);
});

test('HTTP router serves original dashboard and session handshake', async () => {
  const env = { PROXY_SECRET: '000102030405060708090a0b0c0d0e0f' };
  const cfg = await resolveConfig(env);

  const dashRes = await handleHttpRequest(new Request('https://proxy.example.com/'), env);
  assert.equal(dashRes.status, 200);
  const dashHtml = await dashRes.text();
  assert.ok(dashHtml.includes('TWP Core v2.2'));
  assert.ok(dashHtml.includes('https://github.com/telegramdesktop/tproxy-server'));

  const bootTok = await issueStatelessToken(cfg, 1);
  const sessRes = await handleHttpRequest(
    new Request('https://proxy.example.com/api/v1/session', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bootTok}`,
        'Content-Type': 'application/octet-stream',
      },
      body: HELLO_FRAME_BYTES,
    }),
    env
  );
  assert.equal(sessRes.status, 200);
  const welcomeBytes = new Uint8Array(await sessRes.arrayBuffer());
  assert.deepEqual(welcomeBytes, WELCOME_FRAME_BYTES);
});

test('connectToDatacenter sequential failover connects to datacenter endpoints and handles errors', async () => {
  const sock = await connectToDatacenter(2);
  assert.ok(sock);
  assert.ok(sock.opened);
  safeCloseSocket(sock);

  await assert.rejects(
    async () => {
      await connectToDatacenter(999);
    },
    { message: /Unsupported DC ID/ }
  );
});

import { EventEmitter } from 'node:events';

class MockCarrierWs extends EventEmitter {
  constructor(peer) {
    super();
    this.peer = peer;
    this.readyState = 1;
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
  }
  send(data) {
    if (this.peer && this.peer.readyState === 1) {
      queueMicrotask(() => {
        let payload = data;
        if (this.peer.binaryType === 'arraybuffer') {
          if (ArrayBuffer.isView(data)) {
            payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          } else if (data instanceof ArrayBuffer) {
            payload = data;
          }
        }
        this.peer.emit('message', { data: payload });
      });
    }
  }
  addEventListener(t, l) { this.on(t, l); }
  removeEventListener(t, l) { this.off(t, l); }
  accept() {}
  close(code) {
    this.readyState = 3;
    if (this.peer) {
      this.peer.readyState = 3;
      this.peer.emit('close', { code });
    }
    this.emit('close', { code });
  }
}

globalThis.WebSocketPair = function() {
  const c = new MockCarrierWs();
  const s = new MockCarrierWs(c);
  c.peer = s;
  return { 0: c, 1: s };
};

const OriginalResponse = globalThis.Response;
globalThis.Response = class MockUpgradeResponse extends OriginalResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(null, { ...init, status: 200 });
      Object.defineProperty(this, 'status', { value: 101, configurable: true });
      this.webSocket = init.webSocket;
    } else {
      super(body, init);
    }
  }
};

test('E2E: Full-duplex Obfuscated2 MTProto carrier streaming and zero-copy downlink', async () => {
  let dcReadableController;
  const writtenChunks = [];
  globalThis.__mockConnect = (address) => ({
    opened: Promise.resolve({ remoteAddress: address.hostname }),
    closed: new Promise(() => {}),
    readable: new ReadableStream({ start(c) { dcReadableController = c; } }),
    writable: new WritableStream({ write(c) { writtenChunks.push(c); } }),
    close() {},
  });

  const env = { PROXY_SECRET: '000102030405060708090a0b0c0d0e0f' };
  const cfg = await resolveConfig(env);
  const bootTok = await issueStatelessToken(cfg, 1);

  const sessRes = await handleHttpRequest(
    new Request('https://proxy.example.com/api/v1/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bootTok}`, 'Content-Type': 'application/octet-stream' },
      body: HELLO_FRAME_BYTES,
    }),
    env
  );
  const sessTok = sessRes.headers.get('X-Session-Token');

  const wsRes = await handleHttpRequest(
    new Request('https://proxy.example.com/api/v1/ws', {
      method: 'GET',
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `tproxy-v1.${sessTok}` },
    }),
    env
  );
  const clientWs = wsRes.webSocket;

  const clientFrames = [];
  clientWs.on('message', (e) => {
    let raw;
    if (e.data instanceof ArrayBuffer) raw = new Uint8Array(e.data);
    else if (ArrayBuffer.isView(e.data)) raw = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    clientFrames.push(...unpackFrameBatch(raw));
  });

  // Client creates stream 1
  clientWs.send(packFrame(FRAME_OPEN, 1));

  // Client builds 64-byte handshake
  const plain = new Uint8Array(64);
  crypto.getRandomValues(plain);
  plain[0] = 0xaa;
  const v = new DataView(plain.buffer);
  v.setUint32(56, 0xdddddddd);
  v.setInt16(60, 2, true);

  const upKey = new Uint8Array(
    await crypto.subtle.digest('SHA-256', concatArrays(plain.subarray(8, 40), cfg.secret16))
  );
  const upIv = plain.slice(40, 56);
  const upCipher = await createAesCtrCipher(upKey, upIv);
  const encInit = await applyAesCtr(upCipher, 0, plain);
  const wireInit = plain.slice();
  wireInit.set(encInit.subarray(56, 64), 56);

  clientWs.send(packFrame(FRAME_DATA, 1, wireInit));
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(writtenChunks.length, 1);
  assert.equal(writtenChunks[0].length, 64);
  assert.ok(clientFrames.some((f) => f.type === FRAME_WINDOW && f.id === 1));

  // Client sends encrypted payload
  const rawPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const encPayload = await applyAesCtr(upCipher, 64, rawPayload);
  clientWs.send(packFrame(FRAME_DATA, 1, encPayload));
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(writtenChunks.length, 2);
  assert.equal(writtenChunks[1].length, 8);

  // DC delivers downlink chunk
  const dcPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  dcReadableController.enqueue(dcPayload);
  await new Promise((r) => setTimeout(r, 100));

  const dataFrames = clientFrames.filter((f) => f.type === FRAME_DATA && f.id === 1);
  assert.equal(dataFrames.length, 1);
  assert.deepEqual(dataFrames[0].payload, dcPayload);

  clientWs.close();
  globalThis.__mockConnect = null;
});

test('E2E: Batched client frames and multi-stream concurrency', async () => {
  globalThis.__mockConnect = (address) => ({
    opened: Promise.resolve({ remoteAddress: address.hostname }),
    closed: new Promise(() => {}),
    readable: new ReadableStream({ start(c) {} }),
    writable: new WritableStream({ write(c) {} }),
    close() {},
  });

  const env = { PROXY_SECRET: '000102030405060708090a0b0c0d0e0f' };
  const cfg = await resolveConfig(env);
  const bootTok = await issueStatelessToken(cfg, 1);
  const sessRes = await handleHttpRequest(
    new Request('https://proxy.example.com/api/v1/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bootTok}`, 'Content-Type': 'application/octet-stream' },
      body: HELLO_FRAME_BYTES,
    }),
    env
  );
  const sessTok = sessRes.headers.get('X-Session-Token');

  const wsRes = await handleHttpRequest(
    new Request('https://proxy.example.com/api/v1/ws', {
      method: 'GET',
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `tproxy-v1.${sessTok}` },
    }),
    env
  );
  const clientWs = wsRes.webSocket;
  const received = [];
  clientWs.on('message', (e) => {
    let raw;
    if (e.data instanceof ArrayBuffer) raw = new Uint8Array(e.data);
    else if (ArrayBuffer.isView(e.data)) raw = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    received.push(...unpackFrameBatch(raw));
  });

  for (let sId = 1; sId <= 3; sId++) {
    const plain = new Uint8Array(64);
    crypto.getRandomValues(plain);
    plain[0] = 0xaa;
    const v = new DataView(plain.buffer);
    v.setUint32(56, 0xdddddddd);
    v.setInt16(60, sId, true);

    const upKey = new Uint8Array(
      await crypto.subtle.digest('SHA-256', concatArrays(plain.subarray(8, 40), cfg.secret16))
    );
    const upIv = plain.slice(40, 56);
    const upCipher = await createAesCtrCipher(upKey, upIv);
    const encInit = await applyAesCtr(upCipher, 0, plain);
    const wireInit = plain.slice();
    wireInit.set(encInit.subarray(56, 64), 56);

    const fOpen = packFrame(FRAME_OPEN, sId);
    const fData = packFrame(FRAME_DATA, sId, wireInit);
    clientWs.send(packFrameBatch([fOpen, fData]));
  }

  await new Promise((r) => setTimeout(r, 150));
  for (let sId = 1; sId <= 3; sId++) {
    assert.ok(received.some((f) => f.type === FRAME_WINDOW && f.id === sId));
  }

  clientWs.close();
  globalThis.__mockConnect = null;
});


