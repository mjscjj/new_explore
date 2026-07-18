// 豆包端到端实时语音 二进制协议编解码（独立模块）。
// 协议：4 字节 header + [event(4)] + [session_id_len(4)+session_id] + payload_size(4) + payload
// 参考火山引擎 WebSocket V3 双向流式协议。全部大端。

export const MsgType = {
  FULL_CLIENT: 0b0001, // 客户端 full request
  AUDIO_CLIENT: 0b0010, // 客户端音频
  FULL_SERVER: 0b1001, // 服务端 full response
  AUDIO_SERVER: 0b1011, // 服务端音频
  ERROR: 0b1111, // 服务端错误
};

const FLAG_WITH_EVENT = 0b0100;
const SER_JSON = 0b0001;
const SER_RAW = 0b0000;
const COMPRESS_NONE = 0b0000;

export const Event = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200, // 上行音频
  SayHello: 300,
  // 下行内容事件
  TTSSentenceStart: 350,
  TTSResponse: 352, // 下行音频
  TTSEnded: 359,
  ASRInfo: 450,
  ASRResponse: 451, // 用户识别文字
  ASREnded: 459,
  ChatResponse: 550, // 助手回复文字
  ChatEnded: 559,
};

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

// 编码一帧
export function encode({ msgType, event, sessionId, payload, serialization }) {
  const ser = serialization ?? (msgType === MsgType.AUDIO_CLIENT ? SER_RAW : SER_JSON);
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    (msgType << 4) | FLAG_WITH_EVENT,
    (ser << 4) | COMPRESS_NONE,
    0x00,
  ]);
  const parts = [header, u32(event)];
  if (sessionId != null) {
    const sid = Buffer.from(sessionId, "utf8");
    parts.push(u32(sid.length), sid);
  }
  let body;
  if (Buffer.isBuffer(payload)) body = payload;
  else body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  parts.push(u32(body.length), body);
  return Buffer.concat(parts);
}

// 解码服务端帧
export function decode(buf) {
  const msgType = (buf[1] >> 4) & 0x0f;
  const flags = buf[1] & 0x0f;
  const serialization = (buf[2] >> 4) & 0x0f;
  let pos = 4;

  let event = null;
  if (flags & FLAG_WITH_EVENT) {
    event = buf.readUInt32BE(pos);
    pos += 4;
  }

  let sessionId = null;
  // full-server / audio-server 带 session_id
  if (msgType === MsgType.FULL_SERVER || msgType === MsgType.AUDIO_SERVER) {
    if (pos + 4 <= buf.length) {
      const sidLen = buf.readUInt32BE(pos);
      pos += 4;
      if (sidLen > 0 && pos + sidLen <= buf.length) {
        sessionId = buf.slice(pos, pos + sidLen).toString("utf8");
        pos += sidLen;
      }
    }
  }

  let payload = null;
  let errorCode = null;
  if (msgType === MsgType.ERROR) {
    errorCode = buf.readUInt32BE(pos);
    pos += 4;
  }
  if (pos + 4 <= buf.length) {
    const plen = buf.readUInt32BE(pos);
    pos += 4;
    payload = buf.slice(pos, pos + plen);
  }

  return { msgType, flags, serialization, event, sessionId, errorCode, payload };
}

// 便捷构造
export const build = {
  startConnection: () => encode({ msgType: MsgType.FULL_CLIENT, event: Event.StartConnection, payload: {} }),
  finishConnection: () => encode({ msgType: MsgType.FULL_CLIENT, event: Event.FinishConnection, payload: {} }),
  startSession: (sessionId, cfg) =>
    encode({ msgType: MsgType.FULL_CLIENT, event: Event.StartSession, sessionId, payload: cfg }),
  finishSession: (sessionId) =>
    encode({ msgType: MsgType.FULL_CLIENT, event: Event.FinishSession, sessionId, payload: {} }),
  audio: (sessionId, pcmBuffer) =>
    encode({ msgType: MsgType.AUDIO_CLIENT, event: Event.TaskRequest, sessionId, payload: pcmBuffer, serialization: SER_RAW }),
  sayHello: (sessionId, text) =>
    encode({ msgType: MsgType.FULL_CLIENT, event: Event.SayHello, sessionId, payload: { content: text } }),
};
