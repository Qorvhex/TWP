/*
This file is part of Telegram Desktop,
the official desktop application for the Telegram messaging service.

For license and copyright information please follow this link:
https://github.com/telegramdesktop/tdesktop/blob/master/LEGAL
*/
#pragma once

#include "mtproto/details/mtproto_abstract_socket.h"
#include "mtproto/mtproto_proxy_data.h"

#include <QtNetwork/QSslSocket>
#include <QtCore/QByteArray>

namespace MTP::details {

class WorkerSocket final : public AbstractSocket {
public:
	WorkerSocket(
		not_null<QThread*> thread,
		const ProxyData &proxy);
	~WorkerSocket();

	void connectToHost(const QString &address, int port) override;
	bool isGoodStartNonce(bytes::const_span nonce) override;
	void timedOut() override;
	bool isConnected() override;
	bool hasBytesAvailable() override;
	int64 read(bytes::span buffer) override;
	void write(bytes::const_span prefix, bytes::const_span buffer) override;

	int32 debugState() override;
	QString debugPostfix() const override;

private:
	enum class State {
		NotConnected,
		Connecting,
		WaitingUpgrade,
		Connected,
		Disconnected,
		Error,
	};

	void onEncrypted();
	void onReadyRead();
	void onDisconnected();
	void onError(QAbstractSocket::SocketError error);

	void sendUpgradeRequest();
	bool readUpgradeResponse();
	bool parseWebSocketFrames();
	void writeWebSocketFrame(const QByteArray &payload, quint8 opcode);

	const ProxyData _proxy;
	QSslSocket _socket;

	QString _targetAddress;
	int _targetPort = 0;

	QByteArray _key;
	QByteArray _raw;
	QByteArray _incoming;
	int _incomingOffset = 0;
	State _state = State::NotConnected;

};

} // namespace MTP::details
