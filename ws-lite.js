'use strict';
/**
 * 의존성 없는 최소 WebSocket 서버 (RFC 6455 중 텍스트 메시지에 필요한 부분만).
 * - HTTP 서버의 'upgrade' 이벤트에 붙어서 동작합니다.
 * - 텍스트 프레임, 분할(fragment) 프레임, ping/pong, close 를 처리합니다.
 * - 바이너리 프레임은 무시합니다. (이 게임은 JSON 텍스트만 씁니다)
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_WRITE_BACKLOG = 1 << 20; // 1MB 넘게 밀리면 느린 클라이언트로 보고 끊음

class Connection extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragOp = 0;
    this.fragLen = 0;
    this.closed = false;
    this.finished = false;
    this.isAlive = true;
    this.ctx = null; // 서버가 방/플레이어 정보를 붙여 두는 자리

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('end', () => socket.destroy());
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    while (!this.closed) {
      const buf = this.buffer;
      if (buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      // 클라이언트 → 서버 프레임은 반드시 마스킹되어 있어야 합니다.
      if (rsv !== 0 || !masked) return this._fail(1002);

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return this._fail(1009);
        len = buf.readUInt32BE(6);
        off = 10;
      }

      if (len > this.maxPayload) return this._fail(1009);
      if (buf.length < off + 4 + len) return; // 아직 다 안 옴

      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3];
      this.buffer = buf.subarray(off + 4 + len);

      this._onFrame(fin, op, payload);
    }
  }

  _onFrame(fin, op, payload) {
    if (op >= 0x8) {
      // 제어 프레임
      if (!fin || payload.length > 125) return this._fail(1002);
      if (op === OP.CLOSE) {
        const code = payload.length >= 2 ? payload.subarray(0, 2) : Buffer.from([0x03, 0xe8]);
        this._sendFrame(OP.CLOSE, code);
        this._end();
        return;
      }
      if (op === OP.PING) return this._sendFrame(OP.PONG, payload);
      if (op === OP.PONG) {
        this.isAlive = true;
        return;
      }
      return this._fail(1002);
    }

    if (op === OP.CONT) {
      if (!this.fragOp) return this._fail(1002);
    } else if (op === OP.TEXT || op === OP.BIN) {
      if (this.fragOp) return this._fail(1002);
      this.fragOp = op;
    } else {
      return this._fail(1002);
    }

    this.fragLen += payload.length;
    if (this.fragLen > this.maxPayload) return this._fail(1009);
    this.fragments.push(payload);

    if (fin) {
      const data = Buffer.concat(this.fragments);
      const kind = this.fragOp;
      this.fragments = [];
      this.fragOp = 0;
      this.fragLen = 0;
      if (kind === OP.TEXT) this.emit('message', data.toString('utf8'));
    }
  }

  _sendFrame(op, payload) {
    const s = this.socket;
    if (s.destroyed || !s.writable) return;
    if (s.writableLength > MAX_WRITE_BACKLOG) {
      this.terminate();
      return;
    }
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | op;
    s.write(Buffer.concat([header, payload]));
  }

  send(text) {
    if (this.closed) return;
    this._sendFrame(OP.TEXT, Buffer.from(text, 'utf8'));
  }

  ping() {
    if (this.closed) return;
    this._sendFrame(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.closed) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code);
    this._sendFrame(OP.CLOSE, b);
    this._end();
  }

  terminate() {
    this.closed = true;
    this.socket.destroy();
  }

  _fail(code) {
    this.close(code);
  }

  _end() {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    this.emit('close');
  }
}

/**
 * httpServer 에 WebSocket 업그레이드 처리를 붙입니다.
 * onConnection(conn, req) 에서 conn.on('message'|'close') 로 이벤트를 받으세요.
 */
function attach(httpServer, { maxPayload = 4096, onConnection }) {
  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const conn = new Connection(socket, maxPayload);
    onConnection(conn, req);
    if (head && head.length) conn._onData(head);
  });
}

module.exports = { attach };
