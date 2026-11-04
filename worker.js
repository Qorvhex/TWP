/**
 * ⚡ TWP (Telegram Worker Proxy) Core Engine v2.0
 * High-Performance Serverless Telegram WEB Proxy Relay for Cloudflare Workers
 *
 * Implements the official Telegram WEB Proxy wire contract (tproxy v1):
 * - In-Worker Obfuscated2 Engine (Zero-Copy Downlink, AES-CTR Uplink Re-encryption)
 * - Dynamic Datacenter Selection (DC1 - DC5 over Cloudflare Anycast Sockets)
 * - Multiplexed WebSocket Carrier with Seamless Multi-Lane Rollover
 * - Dual-mode: Direct tg://webproxy bridge & Camouflaged / Interactive Web Dashboard
 *
 * Specification: https://github.com/Qorvhex/TWP
 * License: MIT
 */

import { connect } from 'cloudflare:sockets';

// ==================================================================================
// 1. PROTOCOL CONSTANTS & TELEGRAM DATACENTERS
// ==================================================================================

const BRIDGE_DOMAIN_LABEL = 'tdesktop-web-proxy-bridge-v1\n';
const TOKEN_LABEL_PREFIX  = 'tgp-token-v1\0';
const TOKEN_KEY_DERIVATION = 'tgp-token-key-v1';

// Frame Types (Telegram WEB Proxy v1 Protocol)
const FRAME_OPEN    = 1;
const FRAME_DATA    = 2;
const FRAME_CLOSE   = 3;
const FRAME_WINDOW  = 4;
const FRAME_PING    = 5;
const FRAME_PONG    = 6;
const FRAME_HELLO   = 0x10;
const FRAME_WELCOME = 0x11;

// Flow Control & Buffer Boundaries
const CHUNK_SIZE         = 64 * 1024;        // 64 KiB chunks
const INITIAL_STREAM_WIN = 4 * 1024 * 1024;  // 4 MiB flow credit per stream
const MAX_FRAME_PAYLOAD  = 1024 * 1024;      // 1 MiB max single frame payload
const MAX_FRAMES_PER_MSG = 4096;
const MAX_CARRIER_MSG    = 4 * 1024 * 1024;  // 4 MiB max WebSocket message
const MAX_STREAMS_COUNT  = 48;               // Max concurrent logical streams per session
const MAX_RETIRED_IDS    = 4096;
const DEFAULT_DIAL_LIMIT = 45;               // Streams per lane before warm rollover
const DIAL_TIMEOUT_MS    = 6000;             // TCP connect timeout
const CARRIER_PING_MS    = 20000;            // 20s keep-alive & token renewal

const TOKEN_TTL_BOOTSTRAP = 120;             // 2 minutes
const TOKEN_TTL_SESSION   = 600;             // 10 minutes
const TOKEN_TTL_RENEWAL   = 3600;            // 1 hour renewal grace

/**
 * Official Telegram Datacenter IPv4 Endpoints (Standard Port 443).
 * Negative DC IDs represent media endpoints sharing the same IPs.
 */
const TELEGRAM_DCS = {
  1: ['149.154.175.50', '149.154.175.51'],
  2: ['149.154.167.50', '149.154.167.51', '149.154.167.92'],
  3: ['149.154.175.100', '149.154.175.101'],
  4: ['149.154.167.91', '149.154.167.92'],
  5: ['149.154.171.5', '149.154.171.6'],
};

const PROTOCOL_TAGS = new Set([0xefefefef, 0xeeeeeeee, 0xdddddddd]);
const FORBIDDEN_WORDS = new Set([
  0x44414548, // 'HEAD'
  0x54534f50, // 'POST'
  0x20544547, // 'GET '
  0x4954504f, // 'OPTI'
  0xdddddddd,
  0xeeeeeeee,
  0x02010316,
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ==================================================================================
// 2. BINARY & CRYPTOGRAPHIC PRIMITIVES
// ==================================================================================

function parseHex(hexStr) {
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  }
  return bytes;
}

function concatArrays(...arrays) {
  let length = 0;
  for (const arr of arrays) length += arr.length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function reverseBytes(bytes) {
  const reversed = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i];
  }
  return reversed;
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(base64Url) {
  const standard = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

function writeUint32BE(value) {
  const buffer = new Uint8Array(4);
  new DataView(buffer.buffer).setUint32(0, value);
  return buffer;
}

function packFrame(type, streamId, payload) {
  const payloadLen = payload ? payload.length : 0;
  const frame = new Uint8Array(8 + payloadLen);
  frame[0] = type;
  frame[1] = streamId >>> 16;
  frame[2] = streamId >>> 8;
  frame[3] = streamId;
  new DataView(frame.buffer).setUint32(4, payloadLen);
  if (payloadLen > 0) frame.set(payload, 8);
  return frame;
}

function unpackFrameBatch(bytes) {
  const frames = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  while (cursor < bytes.length) {
    if (frames.length >= MAX_FRAMES_PER_MSG || bytes.length - cursor < 8) {
      throw new Error('TWP: Batch size error');
    }
    const size = view.getUint32(cursor + 4);
    if (size > MAX_FRAME_PAYLOAD || cursor + 8 + size > bytes.length) {
      throw new Error('TWP: Invalid frame length');
    }
    frames.push({
      type: bytes[cursor],
      id: (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3],
      payload: bytes.subarray(cursor + 8, cursor + 8 + size),
    });
    cursor += 8 + size;
  }
  if (frames.length === 0) throw new Error('TWP: Empty frame batch');
  return frames;
}

function validateClientFrame(f) {
  if (f.id === 0) {
    if (f.type !== FRAME_PONG || f.payload.length > 64) throw new Error('TWP: Invalid control frame');
    return;
  }
  if (f.type === FRAME_OPEN || f.type === FRAME_CLOSE) {
    if (f.payload.length !== 0) throw new Error('TWP: Unexpected control payload');
  } else if (f.type === FRAME_DATA) {
    if (f.payload.length === 0) throw new Error('TWP: Zero-length data frame');
  } else if (f.type === FRAME_WINDOW) {
    if (f.payload.length !== 4 || new DataView(f.payload.buffer, f.payload.byteOffset, 4).getUint32(0) === 0) {
      throw new Error('TWP: Malformed window frame');
    }
  } else {
    throw new Error('TWP: Unknown frame type');
  }
}

// ==================================================================================
// 3. WEB CRYPTO PRIMITIVES (HMAC & AES-256-CTR)
// ==================================================================================

async function createHmacKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function computeHmac(key, data) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function computeSha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function incrementCounter128(initialIv, blockOffset) {
  const counter = initialIv.slice();
  let carry = blockOffset;
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const val = counter[i] + (carry % 256);
    counter[i] = val & 255;
    carry = Math.floor(carry / 256) + (val >> 8);
  }
  return counter;
}

async function createAesCtrCipher(keyBytes, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['encrypt']);
  return { cryptoKey, iv };
}

async function applyAesCtr(cipher, byteOffset, inputData) {
  if (inputData.length === 0) return inputData;
  const remainder = byteOffset % 16;
  const blockCounter = incrementCounter128(cipher.iv, Math.floor(byteOffset / 16));
  let source = inputData;
  if (remainder !== 0) {
    source = new Uint8Array(remainder + inputData.length);
    source.set(inputData, remainder);
  }
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CTR', counter: blockCounter, length: 128 }, cipher.cryptoKey, source)
  );
  return remainder !== 0 ? encrypted.subarray(remainder) : encrypted;
}

// ==================================================================================
// 4. CONFIGURATION & STATELESS TOKENS
// ==================================================================================

let cachedConfig = null;

function resolveConfig(env) {
  const secretInput = typeof env?.PROXY_SECRET === 'string'
    ? env.PROXY_SECRET
    : typeof env?.SECRET === 'string'
    ? env.SECRET
    : '';

  const rawSecret = secretInput.trim().toLowerCase() || '000102030405060708090a0b0c0d0e0f';

  if (!cachedConfig || cachedConfig.raw !== rawSecret) {
    cachedConfig = { raw: rawSecret, value: buildConfigKeys(rawSecret) };
  }
  return cachedConfig.value;
}

async function buildConfigKeys(rawSecret) {
  const match = /^(dd)?([0-9a-f]{32})$/.exec(rawSecret);
  if (!match) return null;
  const fullSecretBytes = parseHex(rawSecret);
  const capabilityKey = await createHmacKey(fullSecretBytes);
  const tokenMasterKey = await createHmacKey(
    await computeHmac(capabilityKey, textEncoder.encode(TOKEN_KEY_DERIVATION))
  );
  return {
    fullBytes: fullSecretBytes,
    secret16: parseHex(match[2]),
    isPadded: Boolean(match[1]),
    capabilityKey,
    tokenMasterKey,
  };
}

function resolveMaxDials(env) {
  const val = parseInt(env?.MAX_DIALS, 10);
  return Number.isFinite(val) && val >= 4 ? Math.min(val, 100000) : DEFAULT_DIAL_LIMIT;
}

async function issueStatelessToken(config, kind, epochSec = Math.floor(Date.now() / 1000)) {
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  new DataView(nonce.buffer).setUint32(0, epochSec);
  const mac = (
    await computeHmac(config.tokenMasterKey, concatArrays(textEncoder.encode(TOKEN_LABEL_PREFIX), Uint8Array.of(kind), nonce))
  ).subarray(0, 16);
  return toBase64Url(concatArrays(nonce, mac));
}

async function verifyStatelessToken(config, tokenStr, kind, maxTtl, epochSec = Math.floor(Date.now() / 1000)) {
  if (typeof tokenStr !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(tokenStr)) return false;
  const rawBytes = fromBase64Url(tokenStr);
  if (rawBytes.length !== 32) return false;
  const nonce = rawBytes.subarray(0, 16);
  const providedMac = rawBytes.subarray(16);
  const expectedMac = (
    await computeHmac(config.tokenMasterKey, concatArrays(textEncoder.encode(TOKEN_LABEL_PREFIX), Uint8Array.of(kind), nonce))
  ).subarray(0, 16);

  if (!timingSafeEquals(providedMac, expectedMac)) return false;
  const tokenAge = epochSec - new DataView(nonce.buffer, nonce.byteOffset, 4).getUint32(0);
  return tokenAge >= -30 && tokenAge <= maxTtl;
}

function extractBearerToken(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(authHeader);
  return match ? match[1] : '';
}

// ==================================================================================
// 5. IN-WORKER MTPROTO OBFUSCATED2 RELAY ENGINE
// ==================================================================================

/**
 * Decrypts the 64-byte client Obfuscated2 handshake header using the shared secret.
 * Extracts upload/download encryption keys, DC target ID, and transport tag.
 */
async function parseClientHandshake(config, handshakeBuffer) {
  const clientUpKey = await computeSha256(concatArrays(handshakeBuffer.subarray(8, 40), config.secret16));
  const downKeySource = reverseBytes(handshakeBuffer.subarray(8, 56));
  const clientDownKey = await computeSha256(concatArrays(downKeySource.subarray(0, 32), config.secret16));
  const clientDownIv = downKeySource.slice(32, 48);

  const clientUpCipher = await createAesCtrCipher(clientUpKey, handshakeBuffer.slice(40, 56));
  const decryptedHeader = await applyAesCtr(clientUpCipher, 0, handshakeBuffer);

  const transportTag = new DataView(decryptedHeader.buffer, decryptedHeader.byteOffset + 56, 4).getUint32(0);
  const datacenterId = new DataView(decryptedHeader.buffer, decryptedHeader.byteOffset + 60, 2).getInt16(0, true);

  return {
    clientUpCipher,
    clientDownKey,
    clientDownIv,
    transportTag,
    datacenterId,
  };
}

/**
 * Constructs the 64-byte header for the target Telegram DC.
 * Mathematical Invariant: reversed(dcInit[8..56]) matches client.downKey + client.downIv,
 * so packets sent from the DC directly match client expectations (Zero-Copy Downlink).
 */
async function generateDcHandshake(clientHandshake) {
  while (true) {
    const dcInit = new Uint8Array(64);
    crypto.getRandomValues(dcInit);
    const firstWordLE = new DataView(dcInit.buffer).getUint32(0, true);
    const firstWordBE = new DataView(dcInit.buffer).getUint32(0, false);
    const secondWord = new DataView(dcInit.buffer).getUint32(4, false);

    if (dcInit[0] === 0xef || FORBIDDEN_WORDS.has(firstWordLE) || FORBIDDEN_WORDS.has(firstWordBE) || secondWord === 0) {
      continue;
    }

    // Embed client's download keystream into DC's init header
    dcInit.set(reverseBytes(concatArrays(clientHandshake.clientDownKey, clientHandshake.clientDownIv)), 8);
    new DataView(dcInit.buffer).setUint32(56, clientHandshake.transportTag);
    new DataView(dcInit.buffer).setInt16(60, clientHandshake.datacenterId, true);

    const dcUpCipher = await createAesCtrCipher(dcInit.slice(8, 40), dcInit.slice(40, 56));
    const sealed = await applyAesCtr(dcUpCipher, 0, dcInit);

    const wirePayload = dcInit.slice();
    wirePayload.set(sealed.subarray(56, 64), 56);
    return { wirePayload, dcUpCipher };
  }
}

async function connectToDatacenter(dcId) {
  const targetEndpoints = TELEGRAM_DCS[Math.abs(dcId)];
  if (!targetEndpoints || targetEndpoints.length === 0) {
    throw new Error(`TWP: Unsupported DC ID ${dcId}`);
  }
  let lastError = null;
  for (const hostname of targetEndpoints) {
    try {
      const tcpSocket = connect({ hostname, port: 443 }, { secureTransport: 'off', allowHalfOpen: false });
      if (tcpSocket.opened) {
        await Promise.race([
          tcpSocket.opened,
          new Promise((_, reject) => setTimeout(() => reject(new Error('TWP: DC Connect Timeout')), DIAL_TIMEOUT_MS)),
        ]);
      }
      return tcpSocket;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('TWP: Datacenter connection failed');
}

// ==================================================================================
// 6. MULTIPLEXED CARRIER SESSION MANAGER (SERVE)
// ==================================================================================

function handleCarrierSession(webSocket, config, options) {
  webSocket.binaryType = 'arraybuffer';
  const activeStreams = new Map();
  const retiredStreamIds = new Set();
  let totalDials = 0;
  let isClosed = false;
  let pingIntervalId = null;

  const sendRawBytes = (bytes) => {
    if (isClosed) return;
    try {
      webSocket.send(bytes);
    } catch {
      terminateSession(4001);
    }
  };

  const closeStreamSocket = (stream) => {
    if (stream.isTerminated) return;
    stream.isTerminated = true;
    if (stream.wakeResolver) {
      const resolver = stream.wakeResolver;
      stream.wakeResolver = null;
      resolver();
    }
    try { stream.tcpSocket?.close(); } catch {}
    try { stream.streamReader?.cancel().catch(() => {}); } catch {}
  };

  const terminateSession = (closeCode) => {
    if (isClosed) return;
    isClosed = true;
    if (pingIntervalId) clearInterval(pingIntervalId);
    for (const stream of activeStreams.values()) {
      closeStreamSocket(stream);
    }
    activeStreams.clear();
    try { webSocket.close(closeCode); } catch {}
  };

  const teardownStream = (stream, notifyPeer) => {
    if (stream.isTerminated) return;
    closeStreamSocket(stream);
    activeStreams.delete(stream.streamId);
    if (notifyPeer) {
      sendRawBytes(packFrame(FRAME_CLOSE, stream.streamId));
    }
  };

  const grantFlowWindow = (stream, bytesConsumed) => {
    stream.pendingWindowGrant += bytesConsumed;
    if (stream.isWindowGrantScheduled) return;
    stream.isWindowGrantScheduled = true;
    queueMicrotask(() => {
      stream.isWindowGrantScheduled = false;
      if (stream.isTerminated || isClosed || stream.pendingWindowGrant <= 0) return;
      const amount = stream.pendingWindowGrant;
      stream.pendingWindowGrant = 0;
      sendRawBytes(packFrame(FRAME_WINDOW, stream.streamId, writeUint32BE(amount)));
    });
  };

  /**
   * Pumps data received from Telegram DC back to client as DATA frames.
   * Zero-copy downlink: bytes require no decryption because DC Keystream matches client.
   */
  const pumpDownlink = async (stream) => {
    try {
      while (true) {
        const { value: chunk, done: isDone } = await stream.streamReader.read();
        if (isDone || stream.isTerminated) break;
        for (let offset = 0; offset < chunk.length; ) {
          while (stream.outboundCredit <= 0 && !stream.isTerminated) {
            await new Promise((resolve) => (stream.wakeResolver = resolve));
          }
          if (stream.isTerminated) return;
          const sendLen = Math.min(CHUNK_SIZE, chunk.length - offset, stream.outboundCredit);
          stream.outboundCredit -= sendLen;
          sendRawBytes(packFrame(FRAME_DATA, stream.streamId, chunk.subarray(offset, offset + sendLen)));
          offset += sendLen;
        }
      }
    } catch {}
    teardownStream(stream, true);
  };

  const initializeDatacenterConnection = async (stream) => {
    const clientHandshake = await parseClientHandshake(config, stream.handshakeBuffer);
    if (
      !PROTOCOL_TAGS.has(clientHandshake.transportTag) ||
      (config.isPadded && clientHandshake.transportTag !== 0xdddddddd) ||
      !TELEGRAM_DCS[Math.abs(clientHandshake.datacenterId)]
    ) {
      throw new Error('TWP: Handshake header rejected');
    }

    const dcHandshake = await generateDcHandshake(clientHandshake);
    stream.tcpSocket = await connectToDatacenter(clientHandshake.datacenterId);
    if (stream.isTerminated) {
      closeStreamSocket(stream);
      return;
    }

    stream.streamWriter = stream.tcpSocket.writable.getWriter();
    stream.streamReader = stream.tcpSocket.readable.getReader();

    await stream.streamWriter.write(dcHandshake.wirePayload);
    stream.clientCipher = clientHandshake.clientUpCipher;
    stream.dcCipher = dcHandshake.dcUpCipher;
    stream.isHandshakeComplete = true;

    pumpDownlink(stream);
  };

  const processUplinkPayload = async (stream, chunk) => {
    if (stream.isTerminated) return;
    let remainingChunk = chunk;

    if (!stream.isHandshakeComplete) {
      const neededBytes = Math.min(64 - stream.handshakeBytesReceived, remainingChunk.length);
      stream.handshakeBuffer.set(remainingChunk.subarray(0, neededBytes), stream.handshakeBytesReceived);
      stream.handshakeBytesReceived += neededBytes;
      remainingChunk = remainingChunk.subarray(neededBytes);

      if (stream.handshakeBytesReceived < 64) {
        grantFlowWindow(stream, chunk.length);
        return;
      }
      await initializeDatacenterConnection(stream);
      if (stream.isTerminated) return;
    }

    if (remainingChunk.length > 0) {
      const plaintext = await applyAesCtr(stream.clientCipher, stream.streamByteOffset, remainingChunk);
      const reEncrypted = await applyAesCtr(stream.dcCipher, stream.streamByteOffset, plaintext);
      stream.streamByteOffset += remainingChunk.length;
      await stream.streamWriter.write(reEncrypted);
    }
    grantFlowWindow(stream, chunk.length);
  };

  const handleIncomingFrame = (f) => {
    if (f.id === 0) return;

    if (f.type === FRAME_OPEN) {
      if (retiredStreamIds.has(f.id)) {
        return terminateSession(4001);
      }
      if (retiredStreamIds.size >= MAX_RETIRED_IDS) {
        const oldest = retiredStreamIds.values().next().value;
        retiredStreamIds.delete(oldest);
      }
      retiredStreamIds.add(f.id);

      if (totalDials >= options.maxDials || activeStreams.size >= MAX_STREAMS_COUNT) {
        return sendRawBytes(packFrame(FRAME_CLOSE, f.id));
      }
      totalDials++;

      activeStreams.set(f.id, {
        streamId: f.id,
        isTerminated: false,
        isHandshakeComplete: false,
        outboundCredit: INITIAL_STREAM_WIN,
        wakeResolver: null,
        pendingWindowGrant: 0,
        isWindowGrantScheduled: false,
        handshakeBuffer: new Uint8Array(64),
        handshakeBytesReceived: 0,
        streamByteOffset: 64,
        clientCipher: null,
        dcCipher: null,
        tcpSocket: null,
        streamReader: null,
        streamWriter: null,
        pipelinePromise: Promise.resolve(),
      });
      return;
    }

    const stream = activeStreams.get(f.id);
    if (!stream) {
      if (!retiredStreamIds.has(f.id)) terminateSession(4001);
      return;
    }

    if (f.type === FRAME_DATA) {
      const payloadSlice = f.payload.slice();
      stream.pipelinePromise = stream.pipelinePromise
        .then(() => processUplinkPayload(stream, payloadSlice))
        .catch(() => teardownStream(stream, true));
    } else if (f.type === FRAME_CLOSE) {
      teardownStream(stream, false);
    } else if (f.type === FRAME_WINDOW) {
      const creditIncrement = new DataView(f.payload.buffer, f.payload.byteOffset, 4).getUint32(0);
      stream.outboundCredit = Math.min(0x7fffffff, stream.outboundCredit + creditIncrement);
      if (stream.wakeResolver) {
        const resolver = stream.wakeResolver;
        stream.wakeResolver = null;
        resolver();
      }
    }
  };

  let messageQueue = Promise.resolve();
  webSocket.addEventListener('message', (event) => {
    if (isClosed) return;
    messageQueue = messageQueue.then(async () => {
      if (isClosed) return;
      let data = event.data;
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        try {
          data = await data.arrayBuffer();
        } catch {
          return terminateSession(4001);
        }
      }
      if (ArrayBuffer.isView(data)) {
        data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      }
      if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > MAX_CARRIER_MSG) {
        return terminateSession(4001);
      }
      let frames;
      try {
        frames = unpackFrameBatch(new Uint8Array(data));
        frames.forEach(validateClientFrame);
      } catch {
        return terminateSession(4001);
      }
      for (const f of frames) {
        if (isClosed) return;
        handleIncomingFrame(f);
      }
    }).catch(() => {
      terminateSession(4001);
    });
  });

  webSocket.addEventListener('close', () => terminateSession(1000));
  webSocket.addEventListener('error', () => terminateSession(1000));

  if (options.pingMs) {
    pingIntervalId = setInterval(() => {
      issueStatelessToken(config, 2).then((sessionToken) => {
        sendRawBytes(packFrame(FRAME_PING, 0, textEncoder.encode(sessionToken)));
      }, () => {});
    }, options.pingMs);
  }
}

// ==================================================================================
// 7. BRIDGE SCRIPT & WEB INTERFACE (HTML GENERATION)
// ==================================================================================

/**
 * Sandboxed bridge carrier client executing within Telegram's internal WebView.
 * Handles dual boundaries (TelegramWebProxy and loopback messagePort),
 * multi-lane rollover (cur, next), and ping keepalive.
 */
const EMBEDDED_BRIDGE_SCRIPT = String.raw`(()=>{
'use strict';
const BASE=__BASE__,BOOT=__BOOT__,DIALS=__DIALS__;
const found=/^#android=([A-Za-z0-9_-]{43})$/.exec(location.hash);
const androidNonce=found?found[1]:'';
history.replaceState(null,'',location.pathname);
const QUEUE_LIMIT=33554432,MESSAGE_LIMIT=262144,BUFFER_LIMIT=4194304,FRAME_LIMIT=4096,PAYLOAD_LIMIT=1048576;
const WARM_AT=Math.max(1,DIALS-12),SWITCH_AT=Math.max(1,DIALS-2),QUIET_MS=65000,TRIES=3,DEATHS=4,DEATH_WINDOW_MS=30000;
const HELLO=[16,0,0,0,0,0,0,1,1];
let closed=false,started=false,connected=false,token=BOOT,port=null,queued=0,cur=null,next=null,watch=0;
const lanes=new Set(),route=new Map(),deaths=[];
const post=(value)=>{if(port&&!closed)port.postMessage(value)};
const status=(state)=>post({t:'status',state});
const traffic=(up,down)=>post({t:'traffic',up,down});
const request=(method,token,body)=>({method,body,keepalive:method==='DELETE',mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:Object.assign(token?{Authorization:'Bearer '+token}:{},body?{'Content-Type':'application/octet-stream'}:{})});
const pause=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
function split(buffer){
 const view=new DataView(buffer),frames=[];let at=0;
 while(at<buffer.byteLength){
  if(buffer.byteLength-at<8||frames.length>=FRAME_LIMIT)throw new Error('batch');
  const size=view.getUint32(at+4),end=at+8+size;
  if(size>PAYLOAD_LIMIT||end>buffer.byteLength||(view.getUint8(at)===2&&!size))throw new Error('frame');
  frames.push(at===0&&end===buffer.byteLength?buffer:buffer.slice(at,end));at=end;
 }
 if(!frames.length)throw new Error('empty');
 return frames;
}
function frameOf(type,id,payload){
 const size=payload?payload.length:0,out=new Uint8Array(8+size),view=new DataView(out.buffer);
 view.setUint32(0,id);out[0]=type;view.setUint32(4,size);if(size)out.set(payload,8);
 return out.buffer;
}
const typeOf=(item)=>new DataView(item).getUint8(0);
const idOf=(item)=>new DataView(item).getUint32(0)&16777215;
function fail(){
 if(closed)return;
 status('failed');post({t:'close'});close(true);
}
function close(notify){
 if(closed)return;closed=true;
 if(watch)clearInterval(watch);
 for(const lane of lanes)shut(lane);
 if(notify&&token!==BOOT)fetch(BASE+'api/v1/session',request('DELETE',token,null)).catch(()=>{});
 if(port&&port.close)port.close();
}
function makeLane(){
 const lane={ws:null,ready:false,dead:false,opens:0,streams:new Set(),out:[],heard:0,pinged:false,timer:0};
 lanes.add(lane);return lane;
}
function shut(lane){
 if(lane.dead)return false;
 lane.dead=true;lane.ready=false;lanes.delete(lane);
 if(lane.timer)clearTimeout(lane.timer);
 for(const item of lane.out)queued-=item.byteLength;
 lane.out=[];
 try{if(lane.ws)lane.ws.close()}catch(e){}
 if(cur===lane)cur=null;
 if(next===lane)next=null;
 return true;
}
function lost(lane){
 if(!shut(lane)||closed)return;
 for(const id of lane.streams){if(route.get(id)===lane)route.delete(id);post(frameOf(3,id))}
 lane.streams.clear();
 const now=Date.now();deaths.push(now);
 while(now-deaths[0]>DEATH_WINDOW_MS)deaths.shift();
 if(deaths.length>=DEATHS){fail();return}
 if(connected&&!cur)warm();
}
function retire(lane){
 if(lane!==cur&&lane!==next&&!lane.streams.size&&!lane.out.length)shut(lane);
}
function openSocket(lane,session){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(BASE.replace(/^https:/,'wss:')+'api/v1/ws','tproxy-v1.'+session);
  lane.ws=ws;ws.binaryType='arraybuffer';
  ws.onopen=()=>{if(lane.ws!==ws||lane.dead){reject(new Error('gone'));return}lane.ready=true;lane.heard=Date.now();resolve()};
  ws.onerror=()=>{if(!lane.ready)reject(new Error('socket'))};
  ws.onclose=()=>{if(lane.ws!==ws)return;if(lane.ready)lost(lane);else reject(new Error('socket'))};
  ws.onmessage=(event)=>{if(lane.ws===ws)fromRelay(lane,event.data)};
 });
}
async function connectLane(lane,hello,tries){
 for(let i=1;;i++){
  try{
   const response=await fetch(BASE+'api/v1/session',request('POST',token,hello));
   if(response.status!==200||response.headers.get('X-Carrier-Mode')!=='websocket')throw new Error(response.status===404?'refused':'rejected');
   const session=response.headers.get('X-Session-Token')||'';
   if(!session)throw new Error('token');
   const welcome=await response.arrayBuffer();
   if(lane.dead)return null;
   token=session;
   await openSocket(lane,session);
   return welcome;
  }catch(e){
   if(lane.dead||i>=tries||e.message==='refused')throw e;
   try{if(lane.ws)lane.ws.close()}catch(x){}
   await pause(800*i);
  }
 }
}
function promote(lane){
 if(next===lane)next=null;
 const old=cur;cur=lane;
 flush(lane);
 if(old)retire(old);
}
function warm(){
 if(next||closed)return;
 const lane=makeLane();next=lane;
 connectLane(lane,new Uint8Array(HELLO).buffer,TRIES).then((welcome)=>{if(welcome&&!closed&&!lane.dead)promote(lane)},()=>{
  if(closed)return;
  if(!cur||cur.opens>=SWITCH_AT){fail();return}
  lost(lane);
 });
}
function laneFor(){
 if(cur&&cur.opens<SWITCH_AT)return cur;
 warm();
 return next;
}
function send(lane,item){
 if(lane.dead)return;
 if(queued+item.byteLength>QUEUE_LIMIT){fail();return}
 queued+=item.byteLength;lane.out.push(item);flush(lane);
}
function flush(lane){
 if(closed||!lane.ready)return;
 const ws=lane.ws;
 while(lane.out.length){
  if(ws.bufferedAmount>BUFFER_LIMIT){if(!lane.timer)lane.timer=setTimeout(()=>{lane.timer=0;flush(lane);retire(lane)},10);return}
  let total=0,count=0;
  while(count<lane.out.length&&count<FRAME_LIMIT){
   const size=lane.out[count].byteLength;
   if(count&&total+size>MESSAGE_LIMIT)break;
   total+=size;count++;
  }
  const body=new Uint8Array(total);let at=0;
  for(const item of lane.out.splice(0,count)){body.set(new Uint8Array(item),at);at+=item.byteLength}
  queued-=total;
  try{ws.send(body)}catch(e){lost(lane);return}
  traffic(total,0);
 }
}
function fromApp(item){
 const type=typeOf(item),id=idOf(item);
 if(!id)return;
 if(type===1){
  const lane=laneFor();
  if(!lane)return;
  route.set(id,lane);lane.streams.add(id);lane.opens++;
  send(lane,item);
  if(lane===cur&&lane.opens>=WARM_AT)warm();
  return;
 }
 const lane=route.get(id);
 if(!lane)return;
 if(type===3){route.delete(id);lane.streams.delete(id)}
 send(lane,item);
 if(type===3)retire(lane);
}
function fromRelay(lane,data){
 if(lane.dead||closed)return;
 if(!(data instanceof ArrayBuffer)||!data.byteLength){lost(lane);return}
 let frames;try{frames=split(data)}catch(e){lost(lane);return}
 lane.heard=Date.now();
 traffic(0,data.byteLength);
 for(const item of frames){
  const type=typeOf(item),id=idOf(item);
  if(!id){if(type===5)ping(lane,item);continue}
  if(type===3){lane.streams.delete(id);if(route.get(id)===lane)route.delete(id)}
  post(item);
 }
 retire(lane);
 flush(lane);
}
function ping(lane,item){
 const echo=new Uint8Array(item,8);
 if(echo.length>64)return;
 lane.pinged=true;
 const text=String.fromCharCode.apply(null,echo);
 if(/^[A-Za-z0-9_-]{43}$/.test(text))token=text;
 send(lane,frameOf(6,0,echo));
}
function check(){
 const now=Date.now();
 for(const lane of lanes)if(lane.ready&&lane.pinged&&now-lane.heard>QUIET_MS)lost(lane);
}
async function start(hello){
 status('connecting');
 const lane=makeLane();next=lane;
 try{
  const welcome=await connectLane(lane,hello,1);
  if(!welcome||closed)return;
  connected=true;
  promote(lane);
  post(welcome);status('connected');
  watch=setInterval(check,15000);
 }catch(e){fail()}
}
function onApp(data){
 if(data instanceof ArrayBuffer){
  if(!started){started=true;start(data);return}
  let frames;try{frames=split(data)}catch(e){fail();return}
  for(const item of frames)fromApp(item);
 }else if(data&&data.t==='close')close(true);
}
const bridge=globalThis.TelegramWebProxy;
if(androidNonce&&bridge&&typeof bridge.postMessage==='function'){
 port={postMessage(value){bridge.postMessage(value instanceof ArrayBuffer?value:JSON.stringify(value))},close(){bridge.onmessage=null}};
 bridge.onmessage=(event)=>{
  let data=event.data;
  if(typeof data==='string'){try{data=JSON.parse(data)}catch(e){return}}
  onApp(data);
 };
 status('connecting');
 bridge.postMessage(JSON.stringify({t:'tproxy-android-init',v:1,nonce:androidNonce}));
}
addEventListener('message',(event)=>{
 if(port||event.source!==parent||event.data===null||typeof event.data!=='object')return;
 const keys=Object.keys(event.data).sort();
 if(keys.length!==2||keys[0]!=='t'||keys[1]!=='v'||event.data.t!=='tproxy-init'||event.data.v!==1||event.ports.length!==1)return;
 let from;try{from=new URL(event.origin)}catch(e){return}
 if(from.protocol!=='http:'||from.hostname!=='127.0.0.1'||!from.port||from.origin!==event.origin)return;
 const channel=event.ports[0];
 port={postMessage(value){if(value instanceof ArrayBuffer)channel.postMessage(value,[value]);else channel.postMessage(value)},close(){channel.close()}};
 channel.onmessage=(message)=>onApp(message.data);
 channel.start();status('connecting');
});
addEventListener('pagehide',()=>close(true),{once:true});
})();`;

const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), ' +
  'encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), ' +
  'magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), screen-wake-lock=(), ' +
  'serial=(), usb=(), web-share=(), xr-spatial-tracking=()';

function renderBridgeHtml(hostname, bootstrapToken, maxDials) {
  const nonceBytes = new Uint8Array(18);
  crypto.getRandomValues(nonceBytes);
  const nonceStr = toBase64Url(nonceBytes);

  const populatedScript = EMBEDDED_BRIDGE_SCRIPT
    .replace('__BASE__', () => JSON.stringify(`https://${hostname}/`))
    .replace('__BOOT__', () => JSON.stringify(bootstrapToken))
    .replace('__DIALS__', () => String(maxDials));

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connection</title>
</head>
<body>
  <script nonce="${nonceStr}">${populatedScript}</script>
</body>
</html>`;

  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "child-src 'none'",
    `connect-src 'self' wss://${hostname}`,
    "font-src 'none'",
    "form-action 'none'",
    'frame-ancestors http://127.0.0.1:*',
    "frame-src 'none'",
    "img-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src 'nonce-${nonceStr}'`,
    "style-src 'none'",
    "worker-src 'none'",
    'sandbox allow-same-origin allow-scripts',
  ].join('; ');

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'Permissions-Policy': PERMISSIONS_POLICY,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'off',
    },
  });
}


function toHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

const qriousCode = `/*! QRious v4.0.2 | (C) 2017 Alasdair Mercer | GPL v3 License
Based on jsqrencode | (C) 2010 tz@execpc.com | GPL v3 License
*/
!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?module.exports=e():"function"==typeof define&&define.amd?define(e):t.QRious=e()}(this,function(){"use strict";function t(t,e){var n;return"function"==typeof Object.create?n=Object.create(t):(s.prototype=t,n=new s,s.prototype=null),e&&i(!0,n,e),n}function e(e,n,s,r){var o=this;return"string"!=typeof e&&(r=s,s=n,n=e,e=null),"function"!=typeof n&&(r=s,s=n,n=function(){return o.apply(this,arguments)}),i(!1,n,o,r),n.prototype=t(o.prototype,s),n.prototype.constructor=n,n.class_=e||o.class_,n.super_=o,n}function i(t,e,i){for(var n,s,a=0,h=(i=o.call(arguments,2)).length;a<h;a++){s=i[a];for(n in s)t&&!r.call(s,n)||(e[n]=s[n])}}function n(){}var s=function(){},r=Object.prototype.hasOwnProperty,o=Array.prototype.slice,a=e;n.class_="Nevis",n.super_=Object,n.extend=a;var h=n,f=h.extend(function(t,e,i){this.qrious=t,this.element=e,this.element.qrious=t,this.enabled=Boolean(i)},{draw:function(t){},getElement:function(){return this.enabled||(this.enabled=!0,this.render()),this.element},getModuleSize:function(t){var e=this.qrious,i=e.padding||0,n=Math.floor((e.size-2*i)/t.width);return Math.max(1,n)},getOffset:function(t){var e=this.qrious,i=e.padding;if(null!=i)return i;var n=this.getModuleSize(t),s=Math.floor((e.size-n*t.width)/2);return Math.max(0,s)},render:function(t){this.enabled&&(this.resize(),this.reset(),this.draw(t))},reset:function(){},resize:function(){}}),c=f.extend({draw:function(t){var e,i,n=this.qrious,s=this.getModuleSize(t),r=this.getOffset(t),o=this.element.getContext("2d");for(o.fillStyle=n.foreground,o.globalAlpha=n.foregroundAlpha,e=0;e<t.width;e++)for(i=0;i<t.width;i++)t.buffer[i*t.width+e]&&o.fillRect(s*e+r,s*i+r,s,s)},reset:function(){var t=this.qrious,e=this.element.getContext("2d"),i=t.size;e.lineWidth=1,e.clearRect(0,0,i,i),e.fillStyle=t.background,e.globalAlpha=t.backgroundAlpha,e.fillRect(0,0,i,i)},resize:function(){var t=this.element;t.width=t.height=this.qrious.size}}),u=h.extend(null,{BLOCK:[0,11,15,19,23,27,31,16,18,20,22,24,26,28,20,22,24,24,26,28,28,22,24,24,26,26,28,28,24,24,26,26,26,28,28,24,26,26,26,28,28]}),l=h.extend(null,{BLOCKS:[1,0,19,7,1,0,16,10,1,0,13,13,1,0,9,17,1,0,34,10,1,0,28,16,1,0,22,22,1,0,16,28,1,0,55,15,1,0,44,26,2,0,17,18,2,0,13,22,1,0,80,20,2,0,32,18,2,0,24,26,4,0,9,16,1,0,108,26,2,0,43,24,2,2,15,18,2,2,11,22,2,0,68,18,4,0,27,16,4,0,19,24,4,0,15,28,2,0,78,20,4,0,31,18,2,4,14,18,4,1,13,26,2,0,97,24,2,2,38,22,4,2,18,22,4,2,14,26,2,0,116,30,3,2,36,22,4,4,16,20,4,4,12,24,2,2,68,18,4,1,43,26,6,2,19,24,6,2,15,28,4,0,81,20,1,4,50,30,4,4,22,28,3,8,12,24,2,2,92,24,6,2,36,22,4,6,20,26,7,4,14,28,4,0,107,26,8,1,37,22,8,4,20,24,12,4,11,22,3,1,115,30,4,5,40,24,11,5,16,20,11,5,12,24,5,1,87,22,5,5,41,24,5,7,24,30,11,7,12,24,5,1,98,24,7,3,45,28,15,2,19,24,3,13,15,30,1,5,107,28,10,1,46,28,1,15,22,28,2,17,14,28,5,1,120,30,9,4,43,26,17,1,22,28,2,19,14,28,3,4,113,28,3,11,44,26,17,4,21,26,9,16,13,26,3,5,107,28,3,13,41,26,15,5,24,30,15,10,15,28,4,4,116,28,17,0,42,26,17,6,22,28,19,6,16,30,2,7,111,28,17,0,46,28,7,16,24,30,34,0,13,24,4,5,121,30,4,14,47,28,11,14,24,30,16,14,15,30,6,4,117,30,6,14,45,28,11,16,24,30,30,2,16,30,8,4,106,26,8,13,47,28,7,22,24,30,22,13,15,30,10,2,114,28,19,4,46,28,28,6,22,28,33,4,16,30,8,4,122,30,22,3,45,28,8,26,23,30,12,28,15,30,3,10,117,30,3,23,45,28,4,31,24,30,11,31,15,30,7,7,116,30,21,7,45,28,1,37,23,30,19,26,15,30,5,10,115,30,19,10,47,28,15,25,24,30,23,25,15,30,13,3,115,30,2,29,46,28,42,1,24,30,23,28,15,30,17,0,115,30,10,23,46,28,10,35,24,30,19,35,15,30,17,1,115,30,14,21,46,28,29,19,24,30,11,46,15,30,13,6,115,30,14,23,46,28,44,7,24,30,59,1,16,30,12,7,121,30,12,26,47,28,39,14,24,30,22,41,15,30,6,14,121,30,6,34,47,28,46,10,24,30,2,64,15,30,17,4,122,30,29,14,46,28,49,10,24,30,24,46,15,30,4,18,122,30,13,32,46,28,48,14,24,30,42,32,15,30,20,4,117,30,40,7,47,28,43,22,24,30,10,67,15,30,19,6,118,30,18,31,47,28,34,34,24,30,20,61,15,30],FINAL_FORMAT:[30660,29427,32170,30877,26159,25368,27713,26998,21522,20773,24188,23371,17913,16590,20375,19104,13663,12392,16177,14854,9396,8579,11994,11245,5769,5054,7399,6608,1890,597,3340,2107],LEVELS:{L:1,M:2,Q:3,H:4}}),_=h.extend(null,{EXPONENT:[1,2,4,8,16,32,64,128,29,58,116,232,205,135,19,38,76,152,45,90,180,117,234,201,143,3,6,12,24,48,96,192,157,39,78,156,37,74,148,53,106,212,181,119,238,193,159,35,70,140,5,10,20,40,80,160,93,186,105,210,185,111,222,161,95,190,97,194,153,47,94,188,101,202,137,15,30,60,120,240,253,231,211,187,107,214,177,127,254,225,223,163,91,182,113,226,217,175,67,134,17,34,68,136,13,26,52,104,208,189,103,206,129,31,62,124,248,237,199,147,59,118,236,197,151,51,102,204,133,23,46,92,184,109,218,169,79,158,33,66,132,21,42,84,168,77,154,41,82,164,85,170,73,146,57,114,228,213,183,115,230,209,191,99,198,145,63,126,252,229,215,179,123,246,241,255,227,219,171,75,150,49,98,196,149,55,110,220,165,87,174,65,130,25,50,100,200,141,7,14,28,56,112,224,221,167,83,166,81,162,89,178,121,242,249,239,195,155,43,86,172,69,138,9,18,36,72,144,61,122,244,245,247,243,251,235,203,139,11,22,44,88,176,125,250,233,207,131,27,54,108,216,173,71,142,0],LOG:[255,0,1,25,2,50,26,198,3,223,51,238,27,104,199,75,4,100,224,14,52,141,239,129,28,193,105,248,200,8,76,113,5,138,101,47,225,36,15,33,53,147,142,218,240,18,130,69,29,181,194,125,106,39,249,185,201,154,9,120,77,228,114,166,6,191,139,98,102,221,48,253,226,152,37,179,16,145,34,136,54,208,148,206,143,150,219,189,241,210,19,92,131,56,70,64,30,66,182,163,195,72,126,110,107,58,40,84,250,133,186,61,202,94,155,159,10,21,121,43,78,212,229,172,115,243,167,87,7,112,192,247,140,128,99,13,103,74,222,237,49,197,254,24,227,165,153,119,38,184,180,124,17,68,146,217,35,32,137,46,55,63,209,91,149,188,207,205,144,135,151,178,220,252,190,97,242,86,211,171,20,42,93,158,132,60,57,83,71,109,65,162,31,45,67,216,183,123,164,118,196,23,73,236,127,12,111,246,108,161,59,82,41,157,85,170,251,96,134,177,187,204,62,90,203,89,95,176,156,169,160,81,11,245,22,235,122,117,44,215,79,174,213,233,230,231,173,232,116,214,244,234,168,80,88,175]}),d=h.extend(null,{BLOCK:[3220,1468,2713,1235,3062,1890,2119,1549,2344,2936,1117,2583,1330,2470,1667,2249,2028,3780,481,4011,142,3098,831,3445,592,2517,1776,2234,1951,2827,1070,2660,1345,3177]}),v=h.extend(function(t){var e,i,n,s,r,o=t.value.length;for(this._badness=[],this._level=l.LEVELS[t.level],this._polynomial=[],this._value=t.value,this._version=0,this._stringBuffer=[];this._version<40&&(this._version++,n=4*(this._level-1)+16*(this._version-1),s=l.BLOCKS[n++],r=l.BLOCKS[n++],e=l.BLOCKS[n++],i=l.BLOCKS[n],n=e*(s+r)+r-3+(this._version<=9),!(o<=n)););this._dataBlock=e,this._eccBlock=i,this._neccBlock1=s,this._neccBlock2=r;var a=this.width=17+4*this._version;this.buffer=v._createArray(a*a),this._ecc=v._createArray(e+(e+i)*(s+r)+r),this._mask=v._createArray((a*(a+1)+1)/2),this._insertFinders(),this._insertAlignments(),this.buffer[8+a*(a-8)]=1,this._insertTimingGap(),this._reverseMask(),this._insertTimingRowAndColumn(),this._insertVersion(),this._syncMask(),this._convertBitStream(o),this._calculatePolynomial(),this._appendEccToData(),this._interleaveBlocks(),this._pack(),this._finish()},{_addAlignment:function(t,e){var i,n=this.buffer,s=this.width;for(n[t+s*e]=1,i=-2;i<2;i++)n[t+i+s*(e-2)]=1,n[t-2+s*(e+i+1)]=1,n[t+2+s*(e+i)]=1,n[t+i+1+s*(e+2)]=1;for(i=0;i<2;i++)this._setMask(t-1,e+i),this._setMask(t+1,e-i),this._setMask(t-i,e-1),this._setMask(t+i,e+1)},_appendData:function(t,e,i,n){var s,r,o,a=this._polynomial,h=this._stringBuffer;for(r=0;r<n;r++)h[i+r]=0;for(r=0;r<e;r++){if(255!==(s=_.LOG[h[t+r]^h[i]]))for(o=1;o<n;o++)h[i+o-1]=h[i+o]^_.EXPONENT[v._modN(s+a[n-o])];else for(o=i;o<i+n;o++)h[o]=h[o+1];h[i+n-1]=255===s?0:_.EXPONENT[v._modN(s+a[0])]}},_appendEccToData:function(){var t,e=0,i=this._dataBlock,n=this._calculateMaxLength(),s=this._eccBlock;for(t=0;t<this._neccBlock1;t++)this._appendData(e,i,n,s),e+=i,n+=s;for(t=0;t<this._neccBlock2;t++)this._appendData(e,i+1,n,s),e+=i+1,n+=s},_applyMask:function(t){var e,i,n,s,r=this.buffer,o=this.width;switch(t){case 0:for(s=0;s<o;s++)for(n=0;n<o;n++)n+s&1||this._isMasked(n,s)||(r[n+s*o]^=1);break;case 1:for(s=0;s<o;s++)for(n=0;n<o;n++)1&s||this._isMasked(n,s)||(r[n+s*o]^=1);break;case 2:for(s=0;s<o;s++)for(e=0,n=0;n<o;n++,e++)3===e&&(e=0),e||this._isMasked(n,s)||(r[n+s*o]^=1);break;case 3:for(i=0,s=0;s<o;s++,i++)for(3===i&&(i=0),e=i,n=0;n<o;n++,e++)3===e&&(e=0),e||this._isMasked(n,s)||(r[n+s*o]^=1);break;case 4:for(s=0;s<o;s++)for(e=0,i=s>>1&1,n=0;n<o;n++,e++)3===e&&(e=0,i=!i),i||this._isMasked(n,s)||(r[n+s*o]^=1);break;case 5:for(i=0,s=0;s<o;s++,i++)for(3===i&&(i=0),e=0,n=0;n<o;n++,e++)3===e&&(e=0),(n&s&1)+!(!e|!i)||this._isMasked(n,s)||(r[n+s*o]^=1);break;case 6:for(i=0,s=0;s<o;s++,i++)for(3===i&&(i=0),e=0,n=0;n<o;n++,e++)3===e&&(e=0),(n&s&1)+(e&&e===i)&1||this._isMasked(n,s)||(r[n+s*o]^=1);break;case 7:for(i=0,s=0;s<o;s++,i++)for(3===i&&(i=0),e=0,n=0;n<o;n++,e++)3===e&&(e=0),(e&&e===i)+(n+s&1)&1||this._isMasked(n,s)||(r[n+s*o]^=1)}},_calculateMaxLength:function(){return this._dataBlock*(this._neccBlock1+this._neccBlock2)+this._neccBlock2},_calculatePolynomial:function(){var t,e,i=this._eccBlock,n=this._polynomial;for(n[0]=1,t=0;t<i;t++){for(n[t+1]=1,e=t;e>0;e--)n[e]=n[e]?n[e-1]^_.EXPONENT[v._modN(_.LOG[n[e]]+t)]:n[e-1];n[0]=_.EXPONENT[v._modN(_.LOG[n[0]]+t)]}for(t=0;t<=i;t++)n[t]=_.LOG[n[t]]},_checkBadness:function(){var t,e,i,n,s,r=0,o=this._badness,a=this.buffer,h=this.width;for(s=0;s<h-1;s++)for(n=0;n<h-1;n++)(a[n+h*s]&&a[n+1+h*s]&&a[n+h*(s+1)]&&a[n+1+h*(s+1)]||!(a[n+h*s]||a[n+1+h*s]||a[n+h*(s+1)]||a[n+1+h*(s+1)]))&&(r+=v.N2);var f=0;for(s=0;s<h;s++){for(i=0,o[0]=0,t=0,n=0;n<h;n++)t===(e=a[n+h*s])?o[i]++:o[++i]=1,f+=(t=e)?1:-1;r+=this._getBadness(i)}f<0&&(f=-f);var c=0,u=f;for(u+=u<<2,u<<=1;u>h*h;)u-=h*h,c++;for(r+=c*v.N4,n=0;n<h;n++){for(i=0,o[0]=0,t=0,s=0;s<h;s++)t===(e=a[n+h*s])?o[i]++:o[++i]=1,t=e;r+=this._getBadness(i)}return r},_convertBitStream:function(t){var e,i,n=this._ecc,s=this._version;for(i=0;i<t;i++)n[i]=this._value.charCodeAt(i);var r=this._stringBuffer=n.slice(),o=this._calculateMaxLength();t>=o-2&&(t=o-2,s>9&&t--);var a=t;if(s>9){for(r[a+2]=0,r[a+3]=0;a--;)e=r[a],r[a+3]|=255&e<<4,r[a+2]=e>>4;r[2]|=255&t<<4,r[1]=t>>4,r[0]=64|t>>12}else{for(r[a+1]=0,r[a+2]=0;a--;)e=r[a],r[a+2]|=255&e<<4,r[a+1]=e>>4;r[1]|=255&t<<4,r[0]=64|t>>4}for(a=t+3-(s<10);a<o;)r[a++]=236,r[a++]=17},_getBadness:function(t){var e,i=0,n=this._badness;for(e=0;e<=t;e++)n[e]>=5&&(i+=v.N1+n[e]-5);for(e=3;e<t-1;e+=2)n[e-2]===n[e+2]&&n[e+2]===n[e-1]&&n[e-1]===n[e+1]&&3*n[e-1]===n[e]&&(0===n[e-3]||e+3>t||3*n[e-3]>=4*n[e]||3*n[e+3]>=4*n[e])&&(i+=v.N3);return i},_finish:function(){this._stringBuffer=this.buffer.slice();var t,e,i=0,n=3e4;for(e=0;e<8&&(this._applyMask(e),(t=this._checkBadness())<n&&(n=t,i=e),7!==i);e++)this.buffer=this._stringBuffer.slice();i!==e&&this._applyMask(i),n=l.FINAL_FORMAT[i+(this._level-1<<3)];var s=this.buffer,r=this.width;for(e=0;e<8;e++,n>>=1)1&n&&(s[r-1-e+8*r]=1,e<6?s[8+r*e]=1:s[8+r*(e+1)]=1);for(e=0;e<7;e++,n>>=1)1&n&&(s[8+r*(r-7+e)]=1,e?s[6-e+8*r]=1:s[7+8*r]=1)},_interleaveBlocks:function(){var t,e,i=this._dataBlock,n=this._ecc,s=this._eccBlock,r=0,o=this._calculateMaxLength(),a=this._neccBlock1,h=this._neccBlock2,f=this._stringBuffer;for(t=0;t<i;t++){for(e=0;e<a;e++)n[r++]=f[t+e*i];for(e=0;e<h;e++)n[r++]=f[a*i+t+e*(i+1)]}for(e=0;e<h;e++)n[r++]=f[a*i+t+e*(i+1)];for(t=0;t<s;t++)for(e=0;e<a+h;e++)n[r++]=f[o+t+e*s];this._stringBuffer=n},_insertAlignments:function(){var t,e,i,n=this._version,s=this.width;if(n>1)for(t=u.BLOCK[n],i=s-7;;){for(e=s-7;e>t-3&&(this._addAlignment(e,i),!(e<t));)e-=t;if(i<=t+9)break;i-=t,this._addAlignment(6,i),this._addAlignment(i,6)}},_insertFinders:function(){var t,e,i,n,s=this.buffer,r=this.width;for(t=0;t<3;t++){for(e=0,n=0,1===t&&(e=r-7),2===t&&(n=r-7),s[n+3+r*(e+3)]=1,i=0;i<6;i++)s[n+i+r*e]=1,s[n+r*(e+i+1)]=1,s[n+6+r*(e+i)]=1,s[n+i+1+r*(e+6)]=1;for(i=1;i<5;i++)this._setMask(n+i,e+1),this._setMask(n+1,e+i+1),this._setMask(n+5,e+i),this._setMask(n+i+1,e+5);for(i=2;i<4;i++)s[n+i+r*(e+2)]=1,s[n+2+r*(e+i+1)]=1,s[n+4+r*(e+i)]=1,s[n+i+1+r*(e+4)]=1}},_insertTimingGap:function(){var t,e,i=this.width;for(e=0;e<7;e++)this._setMask(7,e),this._setMask(i-8,e),this._setMask(7,e+i-7);for(t=0;t<8;t++)this._setMask(t,7),this._setMask(t+i-8,7),this._setMask(t,i-8)},_insertTimingRowAndColumn:function(){var t,e=this.buffer,i=this.width;for(t=0;t<i-14;t++)1&t?(this._setMask(8+t,6),this._setMask(6,8+t)):(e[8+t+6*i]=1,e[6+i*(8+t)]=1)},_insertVersion:function(){var t,e,i,n,s=this.buffer,r=this._version,o=this.width;if(r>6)for(t=d.BLOCK[r-7],e=17,i=0;i<6;i++)for(n=0;n<3;n++,e--)1&(e>11?r>>e-12:t>>e)?(s[5-i+o*(2-n+o-11)]=1,s[2-n+o-11+o*(5-i)]=1):(this._setMask(5-i,2-n+o-11),this._setMask(2-n+o-11,5-i))},_isMasked:function(t,e){var i=v._getMaskBit(t,e);return 1===this._mask[i]},_pack:function(){var t,e,i,n=1,s=1,r=this.width,o=r-1,a=r-1,h=(this._dataBlock+this._eccBlock)*(this._neccBlock1+this._neccBlock2)+this._neccBlock2;for(e=0;e<h;e++)for(t=this._stringBuffer[e],i=0;i<8;i++,t<<=1){128&t&&(this.buffer[o+r*a]=1);do{s?o--:(o++,n?0!==a?a--:(n=!n,6===(o-=2)&&(o--,a=9)):a!==r-1?a++:(n=!n,6===(o-=2)&&(o--,a-=8))),s=!s}while(this._isMasked(o,a))}},_reverseMask:function(){var t,e,i=this.width;for(t=0;t<9;t++)this._setMask(t,8);for(t=0;t<8;t++)this._setMask(t+i-8,8),this._setMask(8,t);for(e=0;e<7;e++)this._setMask(8,e+i-7)},_setMask:function(t,e){var i=v._getMaskBit(t,e);this._mask[i]=1},_syncMask:function(){var t,e,i=this.width;for(e=0;e<i;e++)for(t=0;t<=e;t++)this.buffer[t+i*e]&&this._setMask(t,e)}},{_createArray:function(t){var e,i=[];for(e=0;e<t;e++)i[e]=0;return i},_getMaskBit:function(t,e){var i;return t>e&&(i=t,t=e,e=i),i=e,i+=e*e,i>>=1,i+=t},_modN:function(t){for(;t>=255;)t=((t-=255)>>8)+(255&t);return t},N1:3,N2:3,N3:40,N4:10}),p=v,m=f.extend({draw:function(){this.element.src=this.qrious.toDataURL()},reset:function(){this.element.src=""},resize:function(){var t=this.element;t.width=t.height=this.qrious.size}}),g=h.extend(function(t,e,i,n){this.name=t,this.modifiable=Boolean(e),this.defaultValue=i,this._valueTransformer=n},{transform:function(t){var e=this._valueTransformer;return"function"==typeof e?e(t,this):t}}),k=h.extend(null,{abs:function(t){return null!=t?Math.abs(t):null},hasOwn:function(t,e){return Object.prototype.hasOwnProperty.call(t,e)},noop:function(){},toUpperCase:function(t){return null!=t?t.toUpperCase():null}}),w=h.extend(function(t){this.options={},t.forEach(function(t){this.options[t.name]=t},this)},{exists:function(t){return null!=this.options[t]},get:function(t,e){return w._get(this.options[t],e)},getAll:function(t){var e,i=this.options,n={};for(e in i)k.hasOwn(i,e)&&(n[e]=w._get(i[e],t));return n},init:function(t,e,i){"function"!=typeof i&&(i=k.noop);var n,s;for(n in this.options)k.hasOwn(this.options,n)&&(s=this.options[n],w._set(s,s.defaultValue,e),w._createAccessor(s,e,i));this._setAll(t,e,!0)},set:function(t,e,i){return this._set(t,e,i)},setAll:function(t,e){return this._setAll(t,e)},_set:function(t,e,i,n){var s=this.options[t];if(!s)throw new Error("Invalid option: "+t);if(!s.modifiable&&!n)throw new Error("Option cannot be modified: "+t);return w._set(s,e,i)},_setAll:function(t,e,i){if(!t)return!1;var n,s=!1;for(n in t)k.hasOwn(t,n)&&this._set(n,t[n],e,i)&&(s=!0);return s}},{_createAccessor:function(t,e,i){var n={get:function(){return w._get(t,e)}};t.modifiable&&(n.set=function(n){w._set(t,n,e)&&i(n,t)}),Object.defineProperty(e,t.name,n)},_get:function(t,e){return e["_"+t.name]},_set:function(t,e,i){var n="_"+t.name,s=i[n],r=t.transform(null!=e?e:t.defaultValue);return i[n]=r,r!==s}}),M=w,b=h.extend(function(){this._services={}},{getService:function(t){var e=this._services[t];if(!e)throw new Error("Service is not being managed with name: "+t);return e},setService:function(t,e){if(this._services[t])throw new Error("Service is already managed with name: "+t);e&&(this._services[t]=e)}}),B=new M([new g("background",!0,"white"),new g("backgroundAlpha",!0,1,k.abs),new g("element"),new g("foreground",!0,"black"),new g("foregroundAlpha",!0,1,k.abs),new g("level",!0,"L",k.toUpperCase),new g("mime",!0,"image/png"),new g("padding",!0,null,k.abs),new g("size",!0,100,k.abs),new g("value",!0,"")]),y=new b,O=h.extend(function(t){B.init(t,this,this.update.bind(this));var e=B.get("element",this),i=y.getService("element"),n=e&&i.isCanvas(e)?e:i.createCanvas(),s=e&&i.isImage(e)?e:i.createImage();this._canvasRenderer=new c(this,n,!0),this._imageRenderer=new m(this,s,s===e),this.update()},{get:function(){return B.getAll(this)},set:function(t){B.setAll(t,this)&&this.update()},toDataURL:function(t){return this.canvas.toDataURL(t||this.mime)},update:function(){var t=new p({level:this.level,value:this.value});this._canvasRenderer.render(t),this._imageRenderer.render(t)}},{use:function(t){y.setService(t.getName(),t)}});Object.defineProperties(O.prototype,{canvas:{get:function(){return this._canvasRenderer.getElement()}},image:{get:function(){return this._imageRenderer.getElement()}}});var A=O,L=h.extend({getName:function(){}}).extend({createCanvas:function(){},createImage:function(){},getName:function(){return"element"},isCanvas:function(t){},isImage:function(t){}}).extend({createCanvas:function(){return document.createElement("canvas")},createImage:function(){return document.createElement("img")},isCanvas:function(t){return t instanceof HTMLCanvasElement},isImage:function(t){return t instanceof HTMLImageElement}});return A.use(new L),A});

//# sourceMappingURL=qrious.min.js.map`;

/**
 * Renders an ultra-modern AMOLED Dark, responsive, bilingual (Persian & English)
 * dashboard with self-contained QR code generation and one-click Telegram connect.
 */
function renderTwpDashboard(hostname, secretHex) {
  const deepLink = "tg://webproxy?server=" + hostname + "&secret=" + secretHex;
  const webLink = "https://t.me/webproxy?server=" + hostname + "&secret=" + secretHex;

  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>⚡ TWP Core v2.0 | Telegram WEB Proxy</title>
  <style>
    :root {
      --bg: #000000;
      --card-bg: #070a10;
      --card-hover: #0b111c;
      --border: rgba(255, 255, 255, 0.08);
      --border-focus: rgba(0, 210, 255, 0.4);
      --accent: #00d2ff;
      --accent-grad: linear-gradient(135deg, #00d2ff 0%, #0070f3 100%);
      --tg-blue: #229ED9;
      --tg-grad: linear-gradient(135deg, #229ED9 0%, #1778b0 100%);
      --success: #10b981;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --code-bg: #030508;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 50% 0%, rgba(0, 210, 255, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(34, 158, 217, 0.05) 0%, transparent 40%);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Vazirmatn", Tahoma, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.25rem 1rem;
      overflow-x: hidden;
    }
    .container {
      width: 100%;
      max-width: 580px;
      margin: 0 auto;
    }
    .header-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.25rem;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      color: var(--success);
      padding: 0.35rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }
    .lang-toggle {
      display: inline-flex;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 2px;
      gap: 2px;
    }
    .lang-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.3rem 0.65rem;
      font-size: 0.75rem;
      font-weight: 700;
      border-radius: 0.35rem;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .lang-btn.active {
      background: var(--accent);
      color: #000;
      box-shadow: 0 2px 8px rgba(0, 210, 255, 0.3);
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 1.25rem;
      padding: 1.75rem 1.5rem;
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.9), 0 0 30px rgba(0, 210, 255, 0.04);
      position: relative;
    }
    .title-area {
      text-align: center;
      margin-bottom: 1.5rem;
    }
    .logo-glow {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 52px;
      height: 52px;
      border-radius: 1rem;
      background: rgba(34, 158, 217, 0.12);
      border: 1px solid rgba(34, 158, 217, 0.3);
      color: var(--tg-blue);
      margin-bottom: 0.75rem;
      box-shadow: 0 0 20px rgba(34, 158, 217, 0.2);
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 0.35rem;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p.desc {
      color: var(--text-muted);
      font-size: 0.875rem;
      line-height: 1.5;
    }
    .main-connect-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.65rem;
      background: var(--tg-grad);
      color: #fff;
      text-decoration: none;
      font-weight: 700;
      font-size: 1.05rem;
      padding: 0.95rem 1.5rem;
      border-radius: 0.85rem;
      box-shadow: 0 8px 24px -4px rgba(34, 158, 217, 0.45);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      margin-bottom: 1.5rem;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .main-connect-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 30px -4px rgba(34, 158, 217, 0.6);
      filter: brightness(1.08);
    }
    .main-connect-btn:active {
      transform: translateY(0);
    }
    .link-box {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 0.75rem 0.85rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.65rem;
      margin-bottom: 0.85rem;
      transition: border-color 0.2s;
    }
    .link-box:hover {
      border-color: var(--border-focus);
    }
    .link-box code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.8rem;
      color: var(--accent);
      white-space: nowrap;
      overflow-x: auto;
      direction: ltr;
      text-align: left;
    }
    .btn-copy {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--text);
      padding: 0.45rem 0.85rem;
      border-radius: 0.5rem;
      font-size: 0.775rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
      flex-shrink: 0;
    }
    .btn-copy:hover {
      background: rgba(255, 255, 255, 0.16);
      color: var(--accent);
    }
    .btn-copy.copied {
      background: rgba(16, 185, 129, 0.2);
      border-color: var(--success);
      color: var(--success);
    }
    .qr-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.25rem 0 0.5rem 0;
      border-top: 1px solid var(--border);
      margin-top: 1rem;
    }
    .qr-wrapper {
      background: #000000;
      border: 1px solid rgba(0, 210, 255, 0.3);
      padding: 10px;
      border-radius: 0.85rem;
      box-shadow: 0 0 20px rgba(0, 210, 255, 0.15);
      margin-bottom: 0.75rem;
      display: inline-block;
    }
    #qr-canvas {
      display: block;
      border-radius: 0.5rem;
    }
    .qr-caption {
      font-size: 0.775rem;
      color: var(--text-dim);
    }
    .details-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.65rem;
      margin-top: 1.25rem;
      border-top: 1px solid var(--border);
      padding-top: 1.25rem;
    }
    .detail-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      padding: 0.65rem 0.85rem;
    }
    .detail-label {
      font-size: 0.725rem;
      color: var(--text-dim);
      margin-bottom: 0.25rem;
    }
    .detail-val {
      font-size: 0.825rem;
      font-weight: 600;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: ltr;
      text-align: left;
    }
    .guide-box {
      margin-top: 1.25rem;
      background: rgba(0, 210, 255, 0.03);
      border: 1px solid rgba(0, 210, 255, 0.1);
      border-radius: 0.75rem;
      padding: 0.85rem 1rem;
      font-size: 0.8rem;
      line-height: 1.6;
      color: var(--text-muted);
    }
    .guide-box ol {
      margin-right: 1.25rem;
      margin-left: 0;
    }
    [dir="ltr"] .guide-box ol {
      margin-left: 1.25rem;
      margin-right: 0;
    }
    footer {
      text-align: center;
      margin-top: 1.5rem;
      font-size: 0.75rem;
      color: var(--text-dim);
    }
    footer a { color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div class="status-badge">
        <span class="pulse-dot"></span>
        <span id="txt-status">آماده اتصال • آنلاین</span>
      </div>
      <div class="lang-toggle">
        <button id="btn-fa" class="lang-btn active" onclick="setLang('fa')">فارسی</button>
        <button id="btn-en" class="lang-btn" onclick="setLang('en')">English</button>
      </div>
    </div>

    <div class="card">
      <div class="title-area">
        <div class="logo-glow">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
          </svg>
        </div>
        <h1 id="txt-title">⚡ وب‌پروکسی رسمی تلگرام (TWP v2.0)</h1>
        <p class="desc" id="txt-desc">سرورلس روی لبه کلادفلر با فناوری رمزنگاری مستقیم و دانلود صفر-کپی</p>
      </div>

      <a href="${deepLink}" class="main-connect-btn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
        </svg>
        <span id="txt-connect-btn">اتصال مستقیم به تلگرام</span>
      </a>

      <div class="link-box">
        <code>${deepLink}</code>
        <button class="btn-copy" onclick="copyText('${deepLink}', this)">
          <span class="btn-lbl" id="txt-copy-deep">کپی لینک</span>
        </button>
      </div>

      <div class="link-box">
        <code>${webLink}</code>
        <button class="btn-copy" onclick="copyText('${webLink}', this)">
          <span class="btn-lbl" id="txt-copy-web">لینک اشتراک</span>
        </button>
      </div>

      <div class="qr-section">
        <div class="qr-wrapper">
          <canvas id="qr-canvas" width="200" height="200"></canvas>
        </div>
        <span class="qr-caption" id="txt-qr-caption">اسکن با دوربین گوشی جهت اتصال سریع</span>
      </div>

      <div class="details-grid">
        <div class="detail-item">
          <div class="detail-label" id="lbl-server">سرور / دامنه</div>
          <div class="detail-val">${hostname}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label" id="lbl-port">پورت اتصال</div>
          <div class="detail-val">443 (TLS 1.3 / WSS)</div>
        </div>
        <div class="detail-item">
          <div class="detail-label" id="lbl-proto">نوع پروتکل</div>
          <div class="detail-val">Telegram WEB Proxy v1</div>
        </div>
        <div class="detail-item">
          <div class="detail-label" id="lbl-enc">رمزنگاری داده</div>
          <div class="detail-val">Obfuscated2 (Zero-Copy)</div>
        </div>
      </div>

      <div class="guide-box">
        <div style="font-weight:700; color:var(--text); margin-bottom:0.4rem;" id="txt-guide-title">💡 راهنمای اتصال سریع:</div>
        <ol>
          <li id="txt-g1">روی دکمه «اتصال مستقیم به تلگرام» کلیک کنید تا پروکسی در اپلیکیشن باز شود.</li>
          <li id="txt-g2">در پنجره باز شده تلگرام، دکمه «Connect Proxy» را بزنید.</li>
          <li id="txt-g3">این پروتکل نیاز به هیچ اپلیکیشن جانبی یا فیلترشکن ندارد و مستقیم به شبکه لبه متصل می‌شود.</li>
        </ol>
      </div>
    </div>

    <footer>
      TWP Core v2.0 • Powered by Cloudflare Workers • <a href="https://github.com/Qorvhex/TWP" target="_blank">GitHub</a>
    </footer>
  </div>

  <script>${qriousCode}</script>
  <script>
    // QR Code rendering
    try {
      new QRious({
        element: document.getElementById('qr-canvas'),
        value: '${deepLink}',
        size: 200,
        background: '#070a10',
        foreground: '#00d2ff',
        level: 'M'
      });
    } catch(e) {}

    // Clipboard copy
    function copyText(str, btn) {
      navigator.clipboard.writeText(str).then(function() {
        const lbl = btn.querySelector('.btn-lbl');
        const orig = lbl.innerText;
        btn.classList.add('copied');
        lbl.innerText = currentLang === 'fa' ? 'کپی شد!' : 'Copied!';
        setTimeout(function() {
          btn.classList.remove('copied');
          lbl.innerText = orig;
        }, 2000);
      });
    }

    // Bilingual i18n
    const i18n = {
      fa: {
        dir: 'rtl',
        status: 'آماده اتصال • آنلاین',
        title: '⚡ وب‌پروکسی رسمی تلگرام (TWP v2.0)',
        desc: 'سرورلس روی لبه کلادفلر با فناوری رمزنگاری مستقیم و دانلود صفر-کپی',
        connectBtn: 'اتصال مستقیم به تلگرام',
        copyDeep: 'کپی لینک',
        copyWeb: 'لینک اشتراک',
        qrCaption: 'اسکن با دوربین گوشی جهت اتصال سریع',
        server: 'سرور / دامنه',
        port: 'پورت اتصال',
        proto: 'نوع پروتکل',
        enc: 'رمزنگاری داده',
        guideTitle: '💡 راهنمای اتصال سریع:',
        g1: 'روی دکمه «اتصال مستقیم به تلگرام» کلیک کنید تا پروکسی در اپلیکیشن باز شود.',
        g2: 'در پنجره باز شده تلگرام، دکمه «Connect Proxy» را بزنید.',
        g3: 'این پروتکل نیاز به هیچ اپلیکیشن جانبی یا فیلترشکن ندارد و مستقیم به شبکه لبه متصل می‌شود.'
      },
      en: {
        dir: 'ltr',
        status: 'Online • Edge Ready',
        title: '⚡ Telegram WEB Proxy (TWP v2.0)',
        desc: '100% Serverless on Cloudflare Edge with In-Worker Obfuscated2 Engine',
        connectBtn: 'Connect in Telegram',
        copyDeep: 'Copy Link',
        copyWeb: 'Share Link',
        qrCaption: 'Scan with phone camera to connect',
        server: 'Server / Host',
        port: 'Port',
        proto: 'Protocol',
        enc: 'Encryption',
        guideTitle: '💡 Quick Connection Guide:',
        g1: 'Click "Connect in Telegram" to open the proxy directly in the app.',
        g2: 'In Telegram confirmation dialog, tap "Connect Proxy".',
        g3: 'No VPN or third-party client required; routes securely via Cloudflare Anycast.'
      }
    };

    let currentLang = 'fa';
    function setLang(lang) {
      currentLang = lang;
      const t = i18n[lang];
      document.documentElement.dir = t.dir;
      document.documentElement.lang = lang;

      document.getElementById('btn-fa').classList.toggle('active', lang === 'fa');
      document.getElementById('btn-en').classList.toggle('active', lang === 'en');

      document.getElementById('txt-status').innerText = t.status;
      document.getElementById('txt-title').innerText = t.title;
      document.getElementById('txt-desc').innerText = t.desc;
      document.getElementById('txt-connect-btn').innerText = t.connectBtn;
      document.getElementById('txt-copy-deep').innerText = t.copyDeep;
      document.getElementById('txt-copy-web').innerText = t.copyWeb;
      document.getElementById('txt-qr-caption').innerText = t.qrCaption;

      document.getElementById('lbl-server').innerText = t.server;
      document.getElementById('lbl-port').innerText = t.port;
      document.getElementById('lbl-proto').innerText = t.proto;
      document.getElementById('lbl-enc').innerText = t.enc;

      document.getElementById('txt-guide-title').innerText = t.guideTitle;
      document.getElementById('txt-g1').innerText = t.g1;
      document.getElementById('txt-g2').innerText = t.g2;
      document.getElementById('txt-g3').innerText = t.g3;

      localStorage.setItem('twp_lang', lang);
    }

    const saved = localStorage.getItem('twp_lang');
    if (saved && (saved === 'fa' || saved === 'en')) {
      setLang(saved);
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function renderNotFound() {
  const notFoundHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>';
  return new Response(notFoundHtml, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ==================================================================================
// 8. HTTP REQUEST ROUTER & EXPORT
// ==================================================================================

const HELLO_FRAME_BYTES = Uint8Array.of(FRAME_HELLO, 0, 0, 0, 0, 0, 0, 1, 1);

async function handleHttpRequest(request, env) {
  const config = await resolveConfig(env);
  if (!config) return renderNotFound();

  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();

  // Route 1: Bridge Initializer
  if (url.pathname === '/' && request.method === 'GET' && /^\?bridge=[A-Za-z0-9_-]{43}$/.test(url.search)) {
    const expectedCapability = toBase64Url(
      await computeHmac(config.capabilityKey, textEncoder.encode(BRIDGE_DOMAIN_LABEL + hostname))
    );
    const providedCapability = url.search.slice(8);
    if (!timingSafeEquals(textEncoder.encode(providedCapability), textEncoder.encode(expectedCapability))) {
      return renderNotFound();
    }
    const bootstrapToken = await issueStatelessToken(config, 1);
    return renderBridgeHtml(hostname, bootstrapToken, resolveMaxDials(env));
  }

  // Route 2: Browser Landing Page / Camouflage Mode
  if (url.pathname === '/' && request.method === 'GET' && !url.search) {
    const camouflageUrl = typeof env?.CAMOUFLAGE_URL === 'string' ? env.CAMOUFLAGE_URL.trim() : '';
    if (camouflageUrl) {
      return fetch(camouflageUrl, { headers: request.headers });
    }
    const secretHex = toHex(config.fullBytes);
    return renderTwpDashboard(hostname, secretHex);
  }

  // Route 3: Session Lifecycle API
  if (url.pathname === '/api/v1/session') {
    if (request.method === 'POST') {
      const authBearer = extractBearerToken(request);
      const isBootstrapValid = await verifyStatelessToken(config, authBearer, 1, TOKEN_TTL_BOOTSTRAP);
      const isRenewalValid = isBootstrapValid || (await verifyStatelessToken(config, authBearer, 2, TOKEN_TTL_RENEWAL));
      if (!isRenewalValid) return renderNotFound();

      const declaredLength = parseInt(request.headers.get('Content-Length') || '0', 10);
      if (declaredLength > 64) return renderNotFound();

      const requestBody = new Uint8Array(await request.arrayBuffer());
      if (!timingSafeEquals(requestBody, HELLO_FRAME_BYTES)) return renderNotFound();

      return new Response(packFrame(FRAME_WELCOME, 0), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Session-Token': await issueStatelessToken(config, 2),
          'X-Down-Cursor': '0',
          'X-Carrier-Mode': 'websocket',
        },
      });
    }

    if (request.method === 'DELETE') {
      const authBearer = extractBearerToken(request);
      if (!(await verifyStatelessToken(config, authBearer, 2, TOKEN_TTL_RENEWAL))) {
        return renderNotFound();
      }
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }

    return renderNotFound();
  }

  // Route 4: Multiplexed WebSocket Upgrade
  if (
    url.pathname === '/api/v1/ws' &&
    request.method === 'GET' &&
    (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket'
  ) {
    const rawProtocols = request.headers.get('Sec-WebSocket-Protocol') || '';
    const subprotocols = rawProtocols.split(',').map((p) => p.trim());
    let tokenMatch = null;
    let selectedProtocol = '';
    for (const sp of subprotocols) {
      const match = /^tproxy-v1\.([A-Za-z0-9_-]{43})$/.exec(sp);
      if (match) {
        tokenMatch = match[1];
        selectedProtocol = sp;
        break;
      }
    }
    if (!tokenMatch || !(await verifyStatelessToken(config, tokenMatch, 2, TOKEN_TTL_SESSION))) {
      return renderNotFound();
    }

    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);
    serverSocket.binaryType = 'arraybuffer';
    serverSocket.accept();

    handleCarrierSession(serverSocket, config, {
      maxDials: resolveMaxDials(env),
      pingMs: CARRIER_PING_MS,
    });

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
      headers: { 'Sec-WebSocket-Protocol': selectedProtocol },
    });
  }

  return renderNotFound();
}

export default {
  async fetch(request, env) {
    try {
      return await handleHttpRequest(request, env);
    } catch {
      return renderNotFound();
    }
  },
};
