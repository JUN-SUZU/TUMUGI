import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { connect, StringCodec } from 'nats';
import { createClient } from 'redis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'docs');

const PORT = process.env.PORT || 3000;
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const sc = StringCodec();

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

async function startServer() {
    const redis = createClient({ url: REDIS_URL });
    redis.on('error', (err) => console.error('[Redis Error]', err));
    await redis.connect();

    const nc = await connect({ servers: NATS_URL });
    const js = nc.jetstream();

    const server = http.createServer((req, res) => {
        const safeSuffix = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
        let filePath = path.join(PUBLIC_DIR, safeSuffix);

        fs.stat(filePath, (err, stats) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('404 Not Found');
            }

            if (stats.isDirectory()) {
                filePath = path.join(filePath, 'index.html');
            }

            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';

            fs.readFile(filePath, (err, content) => {
                if (err) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('404 Not Found');
                } else {
                    res.writeHead(200, { 'Content-Type': contentType });
                    res.end(content, 'utf-8');
                }
            });
        });
    });

    const wss = new WebSocketServer({ server });

    // 全接続クライアントへイベントをブロードキャストするヘルパー
    const broadcast = (data, senderWs = null) => {
        const messageStr = JSON.stringify(data);
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client !== senderWs) {
                client.send(messageStr);
            }
        });
    };

    wss.on('connection', async (ws) => {
        console.log('[WebSocket] クライアントが接続しました');

        // 接続確立時にまず全サーバー一覧をRedisから取得して送信
        try {
            const rawGuilds = await redis.get('discord:guilds');
            const guilds = rawGuilds ? JSON.parse(rawGuilds) : {};

            ws.send(JSON.stringify({
                action: 'SERVERS_DATA',
                servers: guilds
            }));
        } catch (e) {
            console.error('[WS Init Error]', e);
        }

        ws.on('message', async (message) => {
            try {
                const payload = JSON.parse(message.toString());
                const { action, guildId } = payload;

                // 1. ギルドデータ取得
                if (action === 'FETCH_GUILD') {
                    const redisKey = `guilds:${guildId}:volumes`;
                    const savedVolumesRaw = await redis.get(redisKey);
                    let savedVolumes = savedVolumesRaw ? JSON.parse(savedVolumesRaw) : {};

                    const activeUsersRaw = await redis.get(`guilds:${guildId}:active_users`);
                    const activeUsers = activeUsersRaw ? JSON.parse(activeUsersRaw) : {};

                    // 現在のVC接続状態（unionIdが存在するか）を確認
                    const unionId = await redis.get(`guilds:${guildId}:unionId`);
                    const isConnectedVC = Boolean(unionId);

                    const userList = Array.isArray(activeUsers) ? activeUsers : Object.values(activeUsers);

                    for (const user of userList) {
                        const uId = typeof user === 'string' ? user : (user.userId || user.id);
                        if (!uId) continue;

                        if (!savedVolumes[uId]) {
                            savedVolumes[uId] = {
                                userId: uId,
                                username: user.username || user.name || `User (${uId.slice(-4)})`,
                                avatarUrl: user.avatarUrl || '',
                                mode: 'absolute',
                                volume: 1.0
                            };
                        } else {
                            if (user.username) savedVolumes[uId].username = user.username;
                            if (user.avatarUrl !== undefined) savedVolumes[uId].avatarUrl = user.avatarUrl;
                        }
                    }

                    ws.send(JSON.stringify({
                        action: 'GUILD_DATA',
                        guildId,
                        volumes: savedVolumes,
                        activeUsers,
                        isConnectedVC // VC接続状態フラグを追加
                    }));
                    return;
                }

                // 2. VOLUME_CHANGE
                if (action === 'VOLUME_CHANGE') {
                    const { guildId, settings } = payload;
                    const redisKey = `guilds:${guildId}:volumes`;

                    // Mixerに必要なデータ (userId, mode, volume) のみに削ぎ落として保存
                    const sanitizedVolumes = {};
                    for (const [uId, config] of Object.entries(settings)) {
                        sanitizedVolumes[uId] = {
                            userId: uId,
                            mode: config.mode || 'absolute',
                            volume: typeof config.volume === 'number' ? config.volume : 1.0
                        };
                    }

                    // Redisへ保存
                    await redis.set(redisKey, JSON.stringify(sanitizedVolumes));

                    // 1. guildId から接続中の unionId を取得
                    const unionId = await redis.get(`guilds:${guildId}:unionId`);

                    let mixerId = null;
                    if (unionId) {
                        // 2. unionId から割り当て中の mixerId を取得
                        mixerId = await redis.get(`unions:${unionId}:mixerId`);
                    }

                    if (mixerId && nc) {
                        // 3. Rustの ControlMessage::VolumeChange に合致するパケットを構築
                        const controlMessage = {
                            action: 'VOLUME_CHANGE',
                            guildId: guildId,
                            settings: sanitizedVolumes
                        };

                        const subject = `mixer.control.${mixerId}`;
                        await nc.publish(subject, sc.encode(JSON.stringify(controlMessage)));
                        console.log(`[JetStream] Published VOLUME_CHANGE to ${subject} (Union: ${unionId})`);
                    } else {
                        console.warn(`[VOLUME_CHANGE] Mixer ID not found for guild: ${guildId} (unionId: ${unionId})`);
                    }

                    // 他の接続中のWebダッシュボードへリアルタイム同期（同期用にはプロファイルも含めて送ってOK）
                    broadcast(guildId, {
                        action: 'VOLUME_UPDATED',
                        guildId,
                        settings
                    });
                    return;
                }
            } catch (e) {
                console.error('[WebSocket Message Error]', e);
            }
        });
    });

    server.listen(PORT, () => {
        console.log(`[Web] サーバーが起動しました: http://localhost:${PORT}`);
    });
}

startServer().catch(console.error);
