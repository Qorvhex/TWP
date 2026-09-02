/*
This file is part of Telegram Desktop,
the official desktop application for the Telegram messaging service.

For license and copyright information please follow this link:
https://github.com/telegramdesktop/tdesktop/blob/master/LEGAL
*/
#include "mtproto/details/mtproto_worker_socket.h"

#include "base/bytes.h"
#include "base/invoke_queued.h"
#include "base/qthelp_url.h"

#include <QtCore/QCryptographicHash>
#include <QtCore/QUrl>

namespace MTP::details {
namespace {

constexpr auto kAcceptGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
constexpr auto kMaxUpgradeResponse = 16 * 1024;
constexpr auto kOpcodeContinuation = 0x00;
constexpr auto kOpcodeText = 0x01;
constexpr auto kOpcodeBinary = 0x02;
constexpr auto kOpcodeClose = 0x08;
constexpr auto kOpcodePing = 0x09;
constexpr auto kOpcodePong = 0x0A;

} // namespace

WorkerSocket::WorkerSocket(
	not_null<QThread*> thread,
	const ProxyData &proxy)
: AbstractSocket(thread)
, _proxy(proxy) {
	Expects(proxy.type == ProxyData::Type::Worker);

	_socket.moveToThread(thread);

	const auto wrap = [&](auto handler) {
		return [=](auto &&...args) {
			InvokeQueued(this, [=] { handler(args...); });
		};
	};
	connect(
		&_socket,
		&QSslSocket::encrypted,
		wrap([=] { onEncrypted(); }));
	connect(
		&_socket,
		&QSslSocket::readyRead,
		wrap([=] { onReadyRead(); }));
	connect(
		&_socket,
		&QSslSocket::disconnected,
		wrap([=] { onDisconnected(); }));
	connect(
		&_socket,
		&QAbstractSocket::errorOccurred,
		wrap([=](QAbstractSocket::SocketError e) { onError(e); }));
}

WorkerSocket::~WorkerSocket() {
	if (_state == State::Connected) {
		writeWebSocketFrame(QByteArray(), kOpcodeClose);
	}
	_socket.abort();
}

void WorkerSocket::connectToHost(const QString &address, int port) {
	Expects(_state == State::NotConnected);

	_targetAddress = address;
	_targetPort = port;
	_state = State::Connecting;

	const auto host = _proxy.host;
	const auto proxyPort = _proxy.port ? _proxy.port : 443;
	_socket.connectToHostEncrypted(host, proxyPort);
}

bool WorkerSocket::isGoodStartNonce(bytes::const_span nonce) {
	Expects(nonce.size() >= 2 * sizeof(uint32));

	const auto bytes = nonce.data();
	const auto zero = *reinterpret_cast<const uchar*>(bytes);
	const auto first = *reinterpret_cast<const uint32*>(bytes);
	const auto second = *(reinterpret_cast<const uint32*>(bytes) + 1);
	return (zero != 0xEFU)
		&& (first != 0x44414548U)
		&& (first != 0x54534F50U)
		&& (first != 0x20544547U)
		&& (first != 0xEEEEEEEEU)
		&& (first != 0xDDDDDDDDU)
		&& (first != 0x02010316U)
		&& (second != 0x00000000U);
}

void WorkerSocket::timedOut() {
}

bool WorkerSocket::isConnected() {
	return (_state == State::Connected);
}

bool WorkerSocket::hasBytesAvailable() {
	return (_incomingOffset < _incoming.size());
}

int64 WorkerSocket::read(bytes::span buffer) {
	const auto available = _incoming.size() - _incomingOffset;
	if (available <= 0) {
		return 0;
	}
	const auto count = int(std::min<std::size_t>(available, buffer.size()));
	if (!count) {
		return 0;
	}
	bytes::copy(
		buffer,
		bytes::make_span(_incoming).subspan(_incomingOffset, count));
	_incomingOffset += count;
	if (_incomingOffset == _incoming.size()) {
		_incoming.clear();
		_incomingOffset = 0;
	} else if (_incomingOffset >= 64 * 1024
		&& _incomingOffset >= _incoming.size() / 2) {
		_incoming.remove(0, _incomingOffset);
		_incomingOffset = 0;
	}
	return count;
}

void WorkerSocket::write(
		bytes::const_span prefix,
		bytes::const_span buffer) {
	Expects(!buffer.empty());

	if (!isConnected()) {
		return;
	}
	auto payload = QByteArray(
		int(prefix.size() + buffer.size()),
		Qt::Uninitialized);
	if (!prefix.empty()) {
		memcpy(payload.data(), prefix.data(), prefix.size());
	}
	memcpy(payload.data() + prefix.size(), buffer.data(), buffer.size());
	writeWebSocketFrame(payload, kOpcodeBinary);
}

int32 WorkerSocket::debugState() {
	return int32(_state);
}

QString WorkerSocket::debugPostfix() const {
	return u"_worker"_q;
}

void WorkerSocket::onEncrypted() {
	if (_state != State::Connecting) {
		return;
	}
	_state = State::WaitingUpgrade;
	sendUpgradeRequest();
}

void WorkerSocket::onReadyRead() {
	_raw.append(_socket.readAll());
	if (_state == State::WaitingUpgrade) {
		if (!readUpgradeResponse()) {
			onError(QAbstractSocket::NetworkError);
			return;
		}
		if (_state != State::Connected) {
			return;
		}
	}
	if (_state == State::Connected) {
		if (!parseWebSocketFrames()) {
			onError(QAbstractSocket::NetworkError);
		}
	}
}

void WorkerSocket::onDisconnected() {
	if (_state == State::Disconnected || _state == State::Error) {
		return;
	}
	_state = State::Disconnected;
	_disconnected.fire({});
}

void WorkerSocket::onError(QAbstractSocket::SocketError error) {
	if (_state == State::Disconnected || _state == State::Error) {
		return;
	}
	_state = State::Error;
	logError(int(error), _socket.errorString());
	_error.fire({});
}

void WorkerSocket::sendUpgradeRequest() {
	auto keyBytes = bytes::vector(16);
	bytes::set_random(bytes::make_span(keyBytes));
	_key = QByteArray(
		reinterpret_cast<const char*>(keyBytes.data()),
		int(keyBytes.size())
	).toBase64();

	auto path = u"/?ip=%1&port=%2"_q
		.arg(_targetAddress)
		.arg(_targetPort);
	if (!_proxy.password.isEmpty()) {
		path += u"&secret="_q + qthelp::url_encode(_proxy.password);
	}

	const auto request = u"GET %1 HTTP/1.1\r\n"
		"Host: %2\r\n"
		"Upgrade: websocket\r\n"
		"Connection: Upgrade\r\n"
		"Sec-WebSocket-Key: %3\r\n"
		"Sec-WebSocket-Version: 13\r\n"
		"\r\n"_q
		.arg(path)
		.arg(_proxy.host)
		.arg(QString::fromLatin1(_key));

	_socket.write(request.toLatin1());
}

bool WorkerSocket::readUpgradeResponse() {
	const auto end = _raw.indexOf("\r\n\r\n");
	if (end < 0) {
		return (_raw.size() < kMaxUpgradeResponse);
	}
	const auto head = _raw.left(end);
	const auto lines = head.split('\n');
	const auto status = lines.isEmpty()
		? QByteArray()
		: lines.front().trimmed();
	if (!status.contains(" 101")) {
		return false;
	}
	const auto accept = _key + kAcceptGuid;
	const auto expected = QCryptographicHash::hash(
		accept,
		QCryptographicHash::Sha1
	).toBase64();

	auto accepted = false;
	for (const auto &line : lines) {
		const auto colon = line.indexOf(':');
		if (colon < 0) {
			continue;
		}
		if (line.left(colon).trimmed().toLower() == "sec-websocket-accept") {
			accepted = (line.mid(colon + 1).trimmed() == expected);
			break;
		}
	}
	if (!accepted) {
		return false;
	}
	_raw.remove(0, end + 4);
	_state = State::Connected;
	_connected.fire({});
	return true;
}

bool WorkerSocket::parseWebSocketFrames() {
	auto offset = 0;
	auto hasPayload = false;
	const auto size = _raw.size();
	const auto data = reinterpret_cast<const uchar*>(_raw.constData());

	while (true) {
		if (size - offset < 2) {
			break;
		}
		const auto first = data[offset];
		const auto second = data[offset + 1];
		const auto opcode = quint8(first & 0x0F);
		const auto masked = ((second & 0x80) != 0);
		auto length = quint64(second & 0x7F);
		auto header = 2;
		if (length == 126) {
			if (size - offset < 4) {
				break;
			}
			length = (quint64(data[offset + 2]) << 8)
				| quint64(data[offset + 3]);
			header = 4;
		} else if (length == 127) {
			if (size - offset < 10) {
				break;
			}
			length = 0;
			for (auto i = 0; i != 8; ++i) {
				length = (length << 8) | quint64(data[offset + 2 + i]);
			}
			header = 10;
		}
		if (masked) {
			header += 4;
		}
		if (quint64(size - offset) < quint64(header) + length) {
			break;
		}
		auto payload = QByteArray(
			_raw.constData() + offset + header,
			int(length));
		if (masked) {
			const auto mask = data + offset + header - 4;
			for (auto i = 0; i != int(length); ++i) {
				payload[i] = char(payload[i] ^ char(mask[i % 4]));
			}
		}
		offset += header + int(length);

		switch (opcode) {
		case kOpcodeContinuation:
		case kOpcodeBinary:
			if (!payload.isEmpty()) {
				_incoming.append(payload);
				hasPayload = true;
			}
			break;
		case kOpcodeClose:
			return false;
		case kOpcodePing:
			writeWebSocketFrame(payload, kOpcodePong);
			break;
		case kOpcodePong:
		case kOpcodeText:
			break;
		default:
			return false;
		}
	}
	if (offset > 0) {
		_raw.remove(0, offset);
	}
	if (hasPayload) {
		_readyRead.fire({});
	}
	return true;
}

void WorkerSocket::writeWebSocketFrame(const QByteArray &payload, quint8 opcode) {
	const auto length = quint64(payload.size());
	auto frame = QByteArray();
	frame.reserve(int(length) + 14);
	frame.append(char(0x80 | opcode));
	if (length < 126) {
		frame.append(char(0x80 | char(length)));
	} else if (length <= 0xFFFF) {
		frame.append(char(0x80 | 126));
		frame.append(char((length >> 8) & 0xFF));
		frame.append(char(length & 0xFF));
	} else {
		frame.append(char(0x80 | 127));
		for (auto i = 7; i >= 0; --i) {
			frame.append(char((length >> (i * 8)) & 0xFF));
		}
	}
	auto maskBytes = bytes::vector(4);
	bytes::set_random(bytes::make_span(maskBytes));
	const auto mask = reinterpret_cast<const char*>(maskBytes.data());
	frame.append(mask, 4);

	const auto from = payload.constData();
	const auto start = frame.size();
	frame.resize(start + int(length));
	auto to = frame.data() + start;
	for (auto i = 0; i != int(length); ++i) {
		to[i] = char(from[i] ^ mask[i % 4]);
	}
	_socket.write(frame);
}

} // namespace MTP::details
