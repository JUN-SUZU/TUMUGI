import config from './../config.json' with { type: 'json' };
import { connect, StringCodec } from 'nats';

// アプリケーション全体で使い回すためのインスタンスを保持
let instance = null;

export class JetStream {
    constructor() {
        this.nc = null;
        this.jsm = null;
        this.js = null;
        this.sc = StringCodec(); // StringCodecもここで持っておくと便利です
    }

    async init() {
        // すでに接続済みの場合は何もしない（シングルトンの担保）
        if (this.nc) return;

        try {
            this.nc = await connect({
                servers: config.nats.servers,
                reconnect: true,
                maxReconnectAttempts: -1, // 無限に再接続を試みる
                reconnectTimeWait: 5000, // 再接続の間隔（ミリ秒）
            });
            console.log('[JetStream] NATSに接続しました');
            
            // JetStreamコンテキストの初期化
            this.jsm = await this.nc.jetstreamManager();
            this.js = this.nc.jetstream();
        } catch (error) {
            console.error('[JetStream] NATSへの接続に失敗しました:', error);
            throw error;
        }
    }
}

// クラスのインスタンスを1つだけ作成
const natsWrapper = new JetStream();

/**
 * NATS接続を初期化し、Core NATSクライアント(nc)を返します。
 * 既存の vc.request.join のコードがそのまま動くように nc を返却します。
 */
export async function createJetStream() {
    await natsWrapper.init();
    return natsWrapper.nc;
}

/**
 * 呼び出し元でエンコード/デコードに使うための StringCodec をエクスポートします。
 */
export const sc = natsWrapper.sc;
