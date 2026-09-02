# Integration Guide: Adding TWP to Any Telegram Client

This guide explains how to add the **Worker Proxy** mode into any custom build of Telegram Desktop or similar client.

---

## 1. Files to Include in Your Build

Place the following two source files in `Telegram/SourceFiles/mtproto/details/`:
- `mtproto_worker_socket.h`
- `mtproto_worker_socket.cpp`

Add them to `Telegram/CMakeLists.txt`:
```cmake
mtproto/details/mtproto_worker_socket.cpp
mtproto/details/mtproto_worker_socket.h
```

---

## 2. Core Modifications Overview

### A. `Telegram/SourceFiles/mtproto/mtproto_proxy_data.h`
Add `Worker` to `enum class Type`:
```cpp
enum class Type : uchar {
    None,
    Socks5,
    Http,
    Mtproto,
    Web,
    Worker,
};
```

### B. `Telegram/SourceFiles/mtproto/connection_tcp.cpp`
Include the header:
```cpp
#include "mtproto/details/mtproto_worker_socket.h"
```
In `TcpConnection::connectToServer()`:
```cpp
_socket = (_proxy.type == ProxyData::Type::Web)
    ? std::make_unique<WebProxySocket>(thread(), _proxy)
    : (_proxy.type == ProxyData::Type::Worker)
    ? std::make_unique<WorkerSocket>(thread(), _proxy)
    : AbstractSocket::Create(...);
```

### C. `Telegram/SourceFiles/boxes/connection_box.cpp`
1. Add `Type::Worker` to `ProxyDataIsShareable` and `ProxyDataToQueryPath`.
2. In `ProxyBox::setupTypes()`:
```cpp
const auto types = std::vector<std::pair<Type, QString>>{
    { Type::Mtproto, u"MTPROTO"_q },
    { Type::Socks5, u"SOCKS5"_q },
    { Type::Http, u"HTTP"_q },
    { Type::Worker, u"WORKER"_q },
};
```
3. Add `ProxyBox::setupWorkerAddress()` to present input fields for the Cloudflare Worker URL and optional Secret token.

### D. `Telegram/SourceFiles/core/local_url_handlers.cpp`
Register the local handler for `tg://worker?...` links:
```cpp
{
    u"^worker/?\\?(.+)(#|$)"_q,
    Handlers::ApplyWorkerProxy,
},
```