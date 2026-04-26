import dgram from 'dgram';
import { EventEmitter } from 'events';

/**
 * Def: Protocol for AudioInterface (Send)
 * 
 * byte addr: description
 * 0-3: Magic Number (0x54554D4D = "TUMM")
 * 4: Version (0x01) 不一致の場合はエラーを返す
 * 5: Type (0x00) 音声データを表すタイプ
 * 6-21: Union ID (16 bytes文字列)
 * 22-29: User ID (uint64に変換した8bytes)
 * 30-37: Guild ID (uint64に変換した8bytes)
 * 38-39: Sequence Number (2 bytes, uint16) 受信側で順序を管理するための番号。0から始まり、65535までカウントアップしてループする。
 * 40-41: Send Timestamp (2 bytes, uint16) 送信側でms単位のタイムスタンプを記録するためのフィールド。受信側でジッタ管理に利用する。
 * 42-43: Payload Length (2 bytes, uint16)
 * 44-...: Audio Payload (PCMバイナリデータ)
 */
/**
 * Def: Protocol for AudioInterface (Receive)
 * 
 * byte addr: description
 * 0-3: Magic Number (0x54554D4D = "TUMM")
 * 4: Version (0x01) 不一致の場合はエラーを返す
 * 5: Type (0x00) 音声データを表すタイプ
 * 6-21: Union ID (16 bytes文字列)
 * 22-29: Guild ID (uint64に変換した8bytes)
 * 30-31: Sequence Number (2 bytes, uint16) 受信側で順序を管理するための番号。0から始まり、65535までカウントアップしてループする。
 * 32-33: Send Timestamp (2 bytes, uint16) 送信側でms単位のタイムスタンプを記録するためのフィールド。受信側でジッタ管理に利用する。
 * 34-35: Payload Length (2 bytes, uint16)
 * 36-...: Audio Payload (PCMバイナリデータ)
 */
/**
 * Def: Protocol for AudioInterface (Notice)
 * 
 * byte addr: description
 * 0-3: Magic Number (0x54554D4D = "TUMM")
 * 4: Version (0x01) 不一致の場合はエラーを返す
 * 5: Type (0x01) アドレス通知を表すタイプ
 * 6-21: Union ID (16 bytes文字列)
 * 22-29: Guild ID (uint64に変換した8bytes)
 */

const MAGIC_NUMBER = 0x54554D4D; // "TUMM" in ASCII
const VERSION = 0x01;
const TYPE_AUDIO = 0x00;
const TYPE_NOTICE = 0x01;
const SEND_HEADER_SIZE = 44; // 送信用のヘッダーサイズ
const RECEIVE_HEADER_SIZE = 36; // 受信用のヘッダーサイズ
const NOTICE_HEADER_SIZE = 30; // アドレス通知パケットのヘッダーサイズ

export class AudioInterface extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.outboundSequenceMap = new Map(); // guildIdごとにシーケンス番号を管理するためのMap
        this.jitterBuffer = new Map(); // guildIdごとに受信したパケットを一時的に保存するジッタバッファ
    }

    /**
     * UDPソケットを起動し、待ち受けを開始します。
     * @param {number} port - バインドするポート番号 (0の場合はOSが空きポートを自動割当)
     * @returns {Promise<Object>} バインドされたアドレス情報
     */
    start(port = 0) {
        return new Promise((resolve, reject) => {
            this.socket = dgram.createSocket('udp4');

            this.socket.on('error', (err) => {
                console.error('[AudioInterface] UDP Socket Error:\n' + err.stack);
                this.socket.close();
            });

            this.socket.on('message', (msg, rinfo) => {
                this._handleMessage(msg, rinfo);
            });

            this.socket.on('listening', () => {
                const address = this.socket.address();
                console.log(`[AudioInterface] UDP Socket listening on ${address.address}:${address.port}`);
                resolve(address);
            });

            this.socket.bind(port);
        });
    }

    /**
     * 受信したUDPパケットのヘッダーを検証し、パースします。
     * @private
     */
    _handleMessage(msg, rinfo) {
        // パケットの最小サイズチェック
        if (msg.length < RECEIVE_HEADER_SIZE) return;

        // マジックナンバーとバージョン、タイプの検証
        const magic = msg.readUInt32BE(0);
        if (magic !== MAGIC_NUMBER) return;
        const version = msg.readUInt8(4);
        if (version !== VERSION) return;
        const type = msg.readUInt8(5);
        if (type !== TYPE_AUDIO) return;

        // ヘッダー情報の抽出
        const unionId = msg.subarray(6, 22).toString('utf8').replace(/\0/g, '');
        const guildId = msg.readBigUInt64BE(22).toString();
        // TODO: 100msまでパケットを溜めてシーケンス番号をもとに20msごとに順番に処理するロジックを実装する
        const sequenceNumber = msg.readUInt16BE(30);
        const timestamp = msg.readUInt16BE(32);

        const dataLen = msg.readInt16BE(34);


        // データ長の妥当性チェック
        if (msg.length < RECEIVE_HEADER_SIZE + dataLen) return;

        const pcmData = msg.subarray(RECEIVE_HEADER_SIZE, RECEIVE_HEADER_SIZE + dataLen);

        // 受信側のジッタバッファ実装
        if (!this.jitterBuffer.has(guildId)) {
            this.jitterBuffer.set(guildId, []);
        }
        const buffer = this.jitterBuffer.get(guildId);
        // パケットをシーケンス番号順に挿入
        buffer.push({ sequenceNumber, timestamp, pcmData });
        buffer.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

        // OoM対策
        if (buffer.length > 100) {
            buffer.splice(0, buffer.length - 100);
        }
        
        // クラス外部へ向けてイベントを発火
        if (buffer.length > 2) {
            this.emit('audio', { unionId, guildId });
        }
    }

    /**
     * 指定されたMixerサーバーへ音声データを送信します。
     * @param {string} targetIp - MixerのIPアドレス
     * @param {number} targetPort - Mixerのポート番号
     * @param {string} unionId - UnionのID (最大16バイトの文字列)
     * @param {string} userId - ユーザーのID (uint64に変換可能な文字列)
     * @param {string} guildId - ギルドのID (uint64に変換可能な文字列)
     * @param {Buffer} pcmBuffer - PCM音声データ
     */
    sendAudio(targetIp, targetPort, unionId, userId, guildId, pcmBuffer) {
        if (!this.socket) {
            console.error('[AudioInterface] Socket is not initialized.');
            return;
        }

        const header = Buffer.alloc(SEND_HEADER_SIZE); // デフォルトで0x00(null)埋めされる

        // 1. ヘッダー情報の書き込み
        header.writeUInt32BE(MAGIC_NUMBER, 0);
        header.writeUInt8(VERSION, 4);
        header.writeUInt8(TYPE_AUDIO, 5);

        // 2. Union ID の書き込み (最大16バイトまでコピー)
        const unionIdBuf = Buffer.from(unionId, 'utf8');
        unionIdBuf.copy(header, 6, 0, Math.min(unionIdBuf.length, 16));

        // 3. User ID と Guild ID の書き込み
        header.writeBigUInt64BE(BigInt(userId), 22);
        header.writeBigUInt64BE(BigInt(guildId), 30);

        // 4. シーケンス番号の書き込み
        const seqKey = `${unionId}:${guildId}:${userId}`;
        let sequenceNumber = this.outboundSequenceMap.get(seqKey) || 0;
        header.writeUInt16BE(sequenceNumber, 38);
        this.outboundSequenceMap.set(seqKey, (sequenceNumber + 1) % 65536); // 0-65535でループ

        // 5. タイムスタンプの書き込み (送信時のms単位のタイムスタンプを記録)
        const timestamp = Date.now() % 65536; // 16ビットに収まるようにモジュロを取る
        header.writeUInt16BE(timestamp, 40);

        // 6. データ長の書き込み
        header.writeInt16BE(pcmBuffer.length, 42);

        // パケットの結合と送信
        const packet = Buffer.concat([header, pcmBuffer]);

        this.socket.send(packet, targetPort, targetIp, (err) => {
            if (err) {
                console.error('[AudioInterface] UDP Send Error:', err);
            }
        });
    }

    clearUserSequence(unionId, guildId, userId) {
        const seqKey = `${unionId}:${guildId}:${userId}`;
        this.outboundSequenceMap.delete(seqKey);
    }

    noticeAddressToMixer(mixerIp, mixerPort, unionId, guildId) {
        // Mixerに対して音声を送信するためのアドレス通知パケットを送る
        if (!this.socket) {
            console.error('[AudioInterface] Socket is not initialized.');
            return;
        }

        const header = Buffer.alloc(NOTICE_HEADER_SIZE); // デフォルトで0x00(null)埋めされる

        // 1. ヘッダー情報の書き込み
        header.writeUInt32BE(MAGIC_NUMBER, 0);
        header.writeUInt8(VERSION, 4);
        header.writeUInt8(TYPE_NOTICE, 5); // Type: Notice

        // 2. Union ID の書き込み (最大16バイトまでコピー)
        const unionIdBuf = Buffer.from(unionId, 'utf8');
        unionIdBuf.copy(header, 6, 0, Math.min(unionIdBuf.length, 16));

        // 3. Guild ID の書き込み
        header.writeBigUInt64BE(BigInt(guildId), 22);

        this.socket.send(header, mixerPort, mixerIp, (err) => {
            if (err) {
                console.error('[AudioInterface] UDP Send Error:', err);
            }
        });
    }

    /**
     * ソケットを安全に閉じます。
     */
    stop() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
            this.outboundSequenceMap.clear();
            console.log('[AudioInterface] UDP Socket closed.');
        }
    }
}
