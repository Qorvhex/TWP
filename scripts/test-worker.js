#!/usr/bin/env node

/**
 * TWP - Worker Diagnostics & Latency Tester
 * Usage: node scripts/test-worker.js <worker_url_or_hostname> [secret]
 */

const targetArg = process.argv[2] || 'telp.qorvhe-x.workers.dev';
const secretArg = process.argv[3] || '';

let host = targetArg.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
const isHttps = true;

console.log('========================================================');
console.log('       TWP - Telegram Worker Proxy Health Check         ');
console.log('========================================================');
console.log(`Target Worker : https://${host}`);
if (secretArg) console.log(`Secret Token  : ${secretArg}`);
console.log('--------------------------------------------------------');

async function runHealthCheck() {
  // 1. Test HTTP Dashboard
  try {
    process.stdout.write('1. Testing HTTP Web Dashboard... ');
    const t0 = Date.now();
    const res = await fetch(`https://${host}`);
    const latency = Date.now() - t0;
    if (res.ok) {
      console.log(`[PASS] (Status: ${res.status}, Latency: ${latency}ms)`);
    } else {
      console.log(`[WARN] (Status: ${res.status})`);
    }
  } catch (err) {
    console.log(`[FAIL] (${err.message})`);
  }

  // 2. Test WebSocket & TCP Bridge to Telegram DC 2 (149.154.167.50:443)
  process.stdout.write('2. Testing WebSocket MTProto Bridge to Telegram DC 2... ');
  const wsUrl = `wss://${host}/?ip=149.154.167.50&port=443${secretArg ? `&secret=${encodeURIComponent(secretArg)}` : ''}`;

  return new Promise((resolve) => {
    const wsStartTime = Date.now();
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.log(`[FAIL] (Cannot create WebSocket: ${err.message})`);
      return resolve();
    }

    const timer = setTimeout(() => {
      console.log('[FAIL] (Timeout after 8000ms)');
      try { ws.close(); } catch {}
      resolve();
    }, 8000);

    ws.onopen = () => {
      const handshakeTime = Date.now() - wsStartTime;
      process.stdout.write(`Connected (${handshakeTime}ms). Sending ping... `);
      // Send Telegram intermediate protocol init header (0xee 0xee 0xee 0xee)
      const probe = new Uint8Array([0xee, 0xee, 0xee, 0xee]);
      ws.send(probe);
    };

    ws.onmessage = (event) => {
      clearTimeout(timer);
      const totalTime = Date.now() - wsStartTime;
      const len = event.data ? (event.data.byteLength || event.data.length || 0) : 0;
      console.log(`[PASS] (Received ${len} bytes from DC, RTT: ${totalTime}ms)`);
      ws.close();
      resolve();
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      console.log(`[FAIL] (WS Error: ${err.message || 'Unknown'})`);
      resolve();
    };

    ws.onclose = (event) => {
      if (event.code !== 1000 && event.code !== 1005) {
        clearTimeout(timer);
        console.log(`[CLOSED] (Code: ${event.code}, Reason: ${event.reason || 'None'})`);
        resolve();
      }
    };
  });
}

runHealthCheck().then(() => {
  console.log('========================================================');
  console.log('Health check complete.');
});