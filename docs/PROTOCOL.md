# TWP Protocol Specification

The **TWP Protocol** defines how Telegram clients interact with Cloudflare Workers over WebSocket to stream raw MTProto TCP packets.

---

## 1. URL Scheme: `tg://worker?...`

Clients support one-click connection and sharing using the custom URL scheme:

### Format
```text
tg://worker?server=<worker_hostname>&port=443[&secret=<optional_secret>]
```

### Query Parameters
| Parameter | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `server` | Yes | - | The Cloudflare Worker domain name (e.g., `my-proxy.workers.dev` or custom domain). |
| `port` | No | `443` | TCP port for HTTPS/WSS (standard is 443). |
| `secret` | No | Empty | Optional authentication token matching the Worker `SECRET` environment variable. |

---

## 2. WebSocket Upgrade Request

The client initiates connection to the Worker URL with standard HTTP WebSocket Upgrade:

```http
GET /?ip=149.154.167.50&port=443&secret=MyToken HTTP/1.1
Host: my-proxy.workers.dev
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

### Route Fallbacks Supported by `worker.js`:
- Query params: `/?ip=<ip>&port=<port>&secret=<secret>`
- Path routing: `/:secret/:ip/:port` or `/:ip/:port`
- Header authentication: `X-Worker-Secret: <secret>`

---

## 3. Data Framing (RFC 6455)

All MTProto packets are transported inside RFC 6455 binary frames:
- **Client to Worker:**
  - Opcode: `0x02` (`kOpcodeBinary`)
  - Mask: Required (4-byte cryptographically secure random mask XORed with payload)
- **Worker to Client:**
  - Opcode: `0x02` (`kOpcodeBinary`)
  - Mask: Unmasked (standard server-to-client framing)
- **Ping / Keepalive:**
  - Standard WebSocket PING (`0x09`) and PONG (`0x0A`) frames are supported.