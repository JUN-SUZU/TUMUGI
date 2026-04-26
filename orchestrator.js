import { connect, StringCodec } from 'nats';
import { createClient } from 'redis';

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MIXER_TTL_SECONDS = 10;
const MAX_MIXER_LOAD = 90; // CPU使用率の百分率(90%以上なら利用しない)

const sc = StringCodec();

/**
 * RedisMapの構造
 * guilds:{guildId}:unionId -> guildIdが接続中のUnionId
 * unions:{unionId}:mixerId -> UnionIdが割当中のMixerId
 * unions:{unionId}:guilds -> UnionIdに接続中のguildIdのリスト
 * mixers:{mixerId}:status -> MixerIdのアドレスと負荷状況
 */

async function startOrchestrator() {
    // Redisクライアントの初期化
    const redis = createClient({ url: REDIS_URL });
    redis.on('error', (err) => console.error('[Redis Error]', err));
    await redis.connect();
    console.log(`[Orchestrator] Redis に接続しました: ${REDIS_URL}`);

    // NATSクライアントの初期化
    const nc = await connect({ servers: NATS_URL });
    console.log(`[Orchestrator] NATS に接続しました: ${NATS_URL}`);

    const disconnectGuild = async (unionId, guildId) => {
        try {
            // ギルドをUnionから削除
            await redis.del(`guilds:${guildId}:unionId`);
            await redis.sRem(`unions:${unionId}:guilds`, guildId);
            const remainingGuilds = await redis.sMembers(`unions:${unionId}:guilds`);
            const mixerId = await redis.get(`unions:${unionId}:mixerId`);
            if (!mixerId) return;
            if (remainingGuilds.length === 0) {
                // 誰もいなくなったUnionは破棄する
                await redis.del(`unions:${unionId}:guilds`);
                await redis.del(`unions:${unionId}:mixerId`);
                nc.publish(`mixer.control.${mixerId}`, sc.encode(JSON.stringify({
                    action: 'DESTROY_UNION',
                    unionId: String(unionId)
                })));
                console.log(`[Destroy] Union ${unionId} を破棄しました`);
            } else {
                // 残りのギルド構成でMixerの設定を更新
                nc.publish(`mixer.control.${mixerId}`, sc.encode(JSON.stringify({
                    action: 'UPDATE_UNION',
                    unionId: String(unionId),
                    guilds: remainingGuilds
                })));
            }
        } catch (e) {
            console.error(`[Disconnect Error] Union: ${unionId}, Guild: ${guildId}`, e);
        }
    };

    // 1. MixerからのHeartbeat受信処理
    const heartbeatSub = nc.subscribe('mixer.heartbeat');
    (async () => {
        for await (const msg of heartbeatSub) {
            try {
                const data = JSON.parse(sc.decode(msg.data));
                const { id, addr, load } = data;

                // RedisにMixerのステータスを保存（TTL付き）
                // TTLが切れると自動的にリストから消滅（ダウン判定）
                const key = `mixers:${id}:status`;
                await redis.set(key, JSON.stringify({ addr, load }), {
                    EX: MIXER_TTL_SECONDS
                });
            } catch (e) {
                console.error('[Heartbeat Error]', e);
            }
        }
    })();

    // 2. BotからのVC接続（Join）要求の処理
    const joinSub = nc.subscribe('vc.request.join');
    (async () => {
        for await (const msg of joinSub) {
            try {
                const { unionId, guildId } = JSON.parse(sc.decode(msg.data));
                console.log(`[Join Request] Union: ${unionId}, Guild: ${guildId}`);

                // すでにこのギルドがどこかのUnionに接続していないか確認
                const connectedUnionId = await redis.get(`guilds:${guildId}:unionId`);
                if (connectedUnionId && connectedUnionId !== String(unionId)) {
                    // 別のUnionに接続している場合は切断処理を行った上で新しいUnionに接続する
                    await disconnectGuild(connectedUnionId, guildId);
                }
                // すでにUnionがMixerに割り当てられているか確認
                let mixerId = await redis.get(`unions:${unionId}:mixerId`);
                let mixerAddr = '';

                if (mixerId && !(await redis.get(`mixers:${mixerId}:status`))) {
                    // 割り当てられたMixerがダウンしている場合は、再度Mixerの選定からやり直す
                    console.warn(`[Join Warning] Union ${unionId} に割り当てられた Mixer ${mixerId} がダウンしています。再度Mixerを選定します。`);
                    await redis.del(`unions:${unionId}:mixerId`);
                    mixerId = null;
                }

                if (!mixerId) {
                    // 新規Unionの場合、最も負荷の低いMixerを探す
                    const keys = await redis.keys('mixers:*:status');
                    if (keys.length === 0) {
                        msg.respond(sc.encode(JSON.stringify({ error: '利用可能なMixerがありません' })));
                        continue;
                    }

                    let bestMixer = null;
                    let lowestLoad = MAX_MIXER_LOAD; // 初期値は最大負荷を超える値に設定

                    for (const key of keys) {
                        const statusStr = await redis.get(key);
                        if (statusStr) {
                            const status = JSON.parse(statusStr);
                            if (status.load < lowestLoad) {
                                lowestLoad = status.load;
                                bestMixer = { id: key.split(':')[1], addr: status.addr };
                            }
                        }
                    }

                    if (!bestMixer) {
                        msg.respond(sc.encode(JSON.stringify({ error: '利用可能なMixerが見つかりませんでした' })));
                        continue;
                    }

                    mixerId = bestMixer.id;
                    mixerAddr = bestMixer.addr;

                    // UnionとMixerのマッピングを保存
                    await redis.set(`unions:${unionId}:mixerId`, mixerId);
                } else {
                    // 既存Unionの場合、割り当てられたMixerのアドレスを取得
                    const statusStr = await redis.get(`mixers:${mixerId}:status`);
                    if (statusStr) {
                        const status = JSON.parse(statusStr);
                        mixerAddr = status.addr;
                    } else {
                        msg.respond(sc.encode(JSON.stringify({ error: '担当Mixerとの通信が一時的に不安定です' })));
                        continue;
                    }
                }

                // ギルドをUnionに追加
                await redis.set(`guilds:${guildId}:unionId`, unionId);
                await redis.sAdd(`unions:${unionId}:guilds`, guildId);// 重複は自動的に排除される
                const currentGuilds = await redis.sMembers(`unions:${unionId}:guilds`);

                // Mixerに「このUnionはこのギルド構成で処理しろ」と命令をPush
                nc.publish(`mixer.control.${mixerId}`, sc.encode(JSON.stringify({
                    action: 'UPDATE_UNION',
                    unionId: String(unionId),
                    guilds: currentGuilds
                })));

                // BotにMixerのアドレスを返答
                msg.respond(sc.encode(JSON.stringify({ mixerAddr })));

            } catch (e) {
                console.error('[Join Error]', e);
                msg.respond(sc.encode(JSON.stringify({ error: '内部エラーが発生しました' })));
            }
        }
    })();

    // 3. BotからのVC退出（Leave）要求の処理
    const leaveSub = nc.subscribe('vc.request.leave');
    (async () => {
        for await (const msg of leaveSub) {
            try {
                const { unionId, guildId } = JSON.parse(sc.decode(msg.data));
                console.log(`[Leave Request] Union: ${unionId}, Guild: ${guildId}`);

                const mixerId = await redis.get(`unions:${unionId}:mixerId`);
                if (!mixerId) continue;

                await disconnectGuild(unionId, guildId);
            } catch (e) {
                console.error('[Leave Error]', e);
            }
        }
    })();

    // 4. MixerからのBoot完了通知の処理(シャドウリブート防止のため、MixerがBoot完了を通知してきたときにUnionのギルド構成を再送する)
    const bootSub = nc.subscribe('mixer.booted');
    (async () => {
        for await (const msg of bootSub) {
            try {
                const { mixerId } = JSON.parse(sc.decode(msg.data));
                console.log(`[Boot Notification] Mixer ${mixerId} が起動完了を通知しました。担当Unionのギルド構成を再送します。`);

                // このMixerが担当しているUnionを探す
                const unionKeys = await redis.keys('unions:*:mixerId');
                for (const key of unionKeys) {
                    const assignedMixerId = await redis.get(key);
                    if (assignedMixerId === mixerId) {
                        const unionId = key.split(':')[1];
                        const guilds = await redis.sMembers(`unions:${unionId}:guilds`);
                        nc.publish(`mixer.control.${mixerId}`, sc.encode(JSON.stringify({
                            action: 'UPDATE_UNION',
                            unionId: String(unionId),
                            guilds
                        })));
                        console.log(`[Boot Notification] Union ${unionId} のギルド構成を再送しました。`);
                    }
                }
            } catch (e) {
                console.error('[Boot Notification Error]', e);
            }
        }
    })();

    console.log('[Orchestrator] 稼働を開始しました');
}

startOrchestrator().catch(console.error);
