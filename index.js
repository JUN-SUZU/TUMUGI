import config from './config.json' with { type: 'json' };
import fs from 'fs';
import {
    Client, GatewayIntentBits, Partials, ActivityType, MessageFlags, PermissionsBitField, ActionRowBuilder,
    StringSelectMenuBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import {
    joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, VoiceConnectionStatus, entersState, getVoiceConnection,
    EndBehaviorType
} from '@discordjs/voice';
import { Postgres } from './utils/Postgres.js';
const pg = new Postgres();
import { createJetStream, sc } from './utils/JetStream.js';
import { AudioInterface } from './utils/AudioInterface.js';
const audioIO = new AudioInterface();
await audioIO.start(config.audioInterfacePort);
import { PassThrough } from 'stream';
import prism from 'prism-media';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.title = 'TUMUGI';
const basecolor = 0x0099ff;

/**
 * playStreamsマップの構造:
 * key: guildId (string)
 * value: {
 *   player: AudioPlayer,
 *   playStream: PassThrough
 * }
 * 
 * これは、各Discordサーバー(guild)ごとにVC接続のAudioPlayerとPCMデータを書き込むためのPassThroughストリームを管理するためのマップです。
 * AudioInterfaceからの音声データを適切なVC接続にルーティングするために使用されます。
 */
const playStreams = new Map(); // guildId -> { player, playStream }

// DiscordBOTのクライアントを作成
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.DirectMessages
    ],
    partials: [
        Partials.Message,
        Partials.Channel
    ]
})

// クライアントの準備ができたときのイベントリスナー
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('グローバルVC', { type: ActivityType.Streaming });
    await client.guilds.fetch();
    client.guilds.cache.forEach(guild => {
        registerSlashCommands(guild);
    });
});

client.on('guildCreate', async (guild) => {
    console.log(`Joined new guild: ${guild.name} (ID: ${guild.id})`);
    registerSlashCommands(guild);
});

const chatInputCommandsHandlers = {
    'connect': async (interaction) => {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return await interaction.reply({
                content: "VCに参加してからコマンドを使用してください",
                flags: MessageFlags.Ephemeral
            });
        }
        const voiceChannelPermissions = voiceChannel.permissionsFor(client.user);
        if (!voiceChannelPermissions.has(PermissionsBitField.Flags.Connect) ||
            !voiceChannelPermissions.has(PermissionsBitField.Flags.Speak) ||
            !voiceChannelPermissions.has(PermissionsBitField.Flags.ViewChannel)) {
            return await interaction.reply({
                content: "このVCに接続するための権限が不足しています。必要な権限: 接続、発言、チャンネルの閲覧",
                flags: MessageFlags.Ephemeral
            });
        }
        const unions = await pg.unions.getByGuildId(interaction.guild.id);
        const unionOptions = unions.map(union => ({
            label: `Union ${union.id}`,
            description: `Leader: ${union.leader_guild_id}, Members: ${union.member_guild_ids.length}`,
            value: union.id
        }));
        if (unionOptions.length === 0) {
            return await interaction.reply({
                content: "利用可能なUnionがありません",
                flags: MessageFlags.Ephemeral
            });
        }
        else if (unionOptions.length === 1) {
            await interaction.reply({
                content: `Union ${unionOptions[0].value} を選択しました。VCに接続しています...`,
                flags: MessageFlags.Ephemeral
            });
            await connectUnion(interaction, unionOptions[0].value);
        }
        else {
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('connectUnionSelect')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(...unionOptions);
            const row = new ActionRowBuilder().addComponents(selectMenu);
            let embed = new EmbedBuilder()
                .setTitle("Unionを選択")
                .setDescription("VCを接続するUnionを選択してください")
                .setColor(basecolor);
            return await interaction.reply({
                embeds: [embed],
                components: [row],
                flags: MessageFlags.Ephemeral
            });
        }
    },
    'disconnect': async (interaction) => {
        const connection = getVoiceConnection(interaction.guild.id);
        if (!connection) {
            return await interaction.reply({
                content: "現在このサーバーはどのUnionにも接続されていません。",
                flags: MessageFlags.Ephemeral
            });
        }
        connection.destroy();
        await interaction.reply({
            content: "VCから切断しました。",
            flags: MessageFlags.Ephemeral
        });
    },
    'create': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const unionId = interaction.options.getString('unionid');
        if (Buffer.byteLength(unionId, 'utf-8') > 16) {
            return await interaction.reply({
                content: "Union IDはUTF-8で16バイト以内である必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const existingUnion = await pg.unions.getByUnionId(unionId);
        if (existingUnion) {
            return await interaction.reply({
                content: `Union ID ${unionId} はすでに存在しています。別のIDを指定してください。`,
                flags: MessageFlags.Ephemeral
            });
        }
        const newUnion = await pg.unions.formation(unionId, interaction.guild.id);
        if (newUnion) {
            await interaction.reply({
                content: `Union ${unionId} を作成しました。`,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.reply({
                content: `Union ${unionId} の作成に失敗しました。もう一度やり直してください。このエラーが続く場合は管理者にお問い合わせください。`,
                flags: MessageFlags.Ephemeral
            });
        }
    },
    'disband': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const unionId = interaction.options.getString('unionid');
        const unionData = await pg.unions.getByUnionId(unionId);
        if (!unionData) {
            return await interaction.reply({
                content: `指定されたUnion ID (${unionId}) は存在しません。`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (interaction.guildId !== unionData.leader_guild_id) {
            return await interaction.reply({
                content: "あなたはこのUnionのリーダーサーバーのサーバー管理者権限を持っている必要があります。\n"
                    + "(コマンドをリーダーサーバーで実行する必要があります)",
                flags: MessageFlags.Ephemeral
            });
        }
        const result = await pg.unions.disband(unionId);
        if (result) {
            await interaction.reply({
                content: `Union ${unionId} を解散しました。`,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.reply({
                content: `Union ${unionId} の解散に失敗しました。もう一度やり直してください。このエラーが続く場合は管理者にお問い合わせください。`,
                flags: MessageFlags.Ephemeral
            });
        }
    },
    'invite': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const targetGuildId = interaction.options.getString('serverid');
        const targetUnionId = interaction.options.getString('unionid');

        // 招待する権限があるか確認する
        const unionData = await pg.unions.getByUnionId(targetUnionId);
        if (!unionData) {
            return await interaction.reply({
                content: `指定されたUnion ID (${targetUnionId}) は存在しません。`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (interaction.guildId !== unionData.leader_guild_id) {
            return await interaction.reply({
                content: "あなたはこのUnionのリーダーサーバーのサーバー管理者権限を持っている必要があります。\n"
                    + "(コマンドをリーダーサーバーで実行する必要があります)",
                flags: MessageFlags.Ephemeral
            });
        }

        await pg.unions.invite(targetUnionId, targetGuildId);
        await interaction.reply({
            content: `サーバーID: ${targetGuildId} を Union ${targetUnionId} に招待しました。`,
            flags: MessageFlags.Ephemeral
        });
    },
    'join': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }

        // Union名をコマンドの引数から取得
        const unionId = interaction.options.getString('unionid');
        const guildId = interaction.guild.id;

        // 招待されているか確認する
        const isInvited = await pg.unions.isInvited(unionId, guildId);
        if (!isInvited) {
            return await interaction.reply({
                content: `Union ${unionId} への参加に失敗しました。招待されているUnionか確認してください。`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Unionに参加する
        const result = await pg.unions.join(unionId, guildId);
        if (result) {
            await interaction.reply({
                content: `Union ${unionId} に参加しました。`,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.reply({
                content: `Union ${unionId} への参加に失敗しました。もう一度やり直してください。このエラーが続く場合は管理者にお問い合わせください。`,
                flags: MessageFlags.Ephemeral
            });
        }
    },
    'expel': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const targetGuildId = interaction.options.getString('serverid');
        const targetUnionId = interaction.options.getString('unionid');


        // 追放する権限があるか確認する
        if (interaction.guildId !== targetGuildId) {
            const unionData = await pg.unions.getByUnionId(targetUnionId);
            if (!unionData) {
                return await interaction.reply({
                    content: `指定されたUnion ID (${targetUnionId}) は存在しません。`,
                    flags: MessageFlags.Ephemeral
                });
            }
            if (interaction.guildId !== unionData.leader_guild_id) {
                return await interaction.reply({
                    content: "あなたはこのUnionのリーダーサーバーのサーバー管理者権限を持っている必要があります。\n"
                        + "(コマンドを実行しているサーバーが追放対象のサーバーではなく、かつリーダーサーバーでもないため)",
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        // 警告画面をモーダルウィンドウで表示して、最終確認する
        const modal = new ModalBuilder()
            .setCustomId(`expelModal:${targetUnionId}:${targetGuildId}`)
            .setTitle('追放の確認');

        const confirmText = new TextInputBuilder()
            .setCustomId('confirmInput')
            .setLabel('確認のため、"追放する" と入力してください')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const actionRow = new ActionRowBuilder().addComponents(confirmText);
        modal.addComponents(actionRow);

        await interaction.showModal(modal);
    }
}

const stringSelectMenuHandlers = {
    'connectUnionSelect': async (interaction) => {
        const selectedUnionId = interaction.values[0];
        await interaction.update({
            content: `Union ${selectedUnionId} を選択しました。VCに接続しています...`,
            embeds: [],
            components: [],
            flags: MessageFlags.Ephemeral
        });
        // Handle the selected union
        await connectUnion(interaction, selectedUnionId);
    }
};


client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            const commandName = interaction.commandName;
            const permissions = interaction.channel.permissionsFor(client.user);
            if (!permissions ||
                !permissions.has(PermissionsBitField.Flags.SendMessages) ||
                !permissions.has(PermissionsBitField.Flags.ViewChannel)) {
                return await interaction.reply({
                    content: "チャンネルの権限が不足しています。必要な権限: メッセージの送信、チャンネルの閲覧",
                    flags: MessageFlags.Ephemeral
                });
            }

            const execute = chatInputCommandsHandlers[commandName];
            if (execute) {
                await execute(interaction);
            }
        } else if (interaction.isStringSelectMenu()) {
            // コロン区切りなしのcustomIdの場合は通常の処理、コロン区切りありの場合は後ろの部分をオプションとして扱う
            const selectId = interaction.customId.split(':')[0];
            const execute = stringSelectMenuHandlers[selectId];
            if (execute) {
                await execute(interaction);
            }
        } else if (interaction.isModalSubmit()) {
            const [action, targetUnionId, targetGuildId] = interaction.customId.split(':');
            if (action === 'expelModal') {
                const confirmInput = interaction.fields.getTextInputValue('confirmInput');
                if (confirmInput !== '追放する') {
                    return await interaction.reply({
                        content: '追放がキャンセルされました。確認の入力が正しくありませんでした。',
                        flags: MessageFlags.Ephemeral
                    });
                }
                const result = await pg.unions.expel(targetUnionId, targetGuildId);
                if (result) {
                    await interaction.reply({
                        content: `サーバーID: ${targetGuildId} を Union ${targetUnionId} から追放しました。`,
                        flags: MessageFlags.Ephemeral
                    });
                } else {
                    await interaction.reply({
                        content: `サーバーID: ${targetGuildId} の Union ${targetUnionId} からの追放に失敗しました。もう一度やり直してください。このエラーが続く場合は管理者にお問い合わせください。`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            }
        }
    } catch (error) {
        console.error(error);
    }
});

/**
 * 指定されたUnionに接続する関数
 * @param {CommandInteraction} interaction - コマンドインタラクションオブジェクト
 * @param {string} unionId - 接続するUnionのID
 */
async function connectUnion(interaction, unionId) {
    const guildId = interaction.guild.id;

    // Orchestratorに接続要求を送信
    const nc = await createJetStream();

    // ※トピック名は orchestrator.js 側の購読名に合わせてください (例: 'vc.request.join')
    const responseJson = await nc.request(
        `vc.request.join`,
        sc.encode(JSON.stringify({
            unionId: String(unionId),
            guildId: guildId
        })),
        { timeout: 5000 }
    ).then((msg) => sc.decode(msg.data)).catch((e) => {
        console.error('Orchestrator request error:', e);
        return null;
    });

    if (!responseJson) {
        return await interaction.editReply({
            content: "Unionへの接続に失敗しました。Orchestratorが応答しませんでした。",
            flags: MessageFlags.Ephemeral
        });
    }

    const responseObject = JSON.parse(responseJson);

    // Orchestrator側で弾かれた場合（二重接続エラーなど）
    if (responseObject.error) {
        return await interaction.editReply({
            content: `⚠️ ${responseObject.error}`,
            flags: MessageFlags.Ephemeral
        });
    }

    const mixerAddr = responseObject.mixerAddr;
    const [mixerIp, mixerPortStr] = mixerAddr.split(':');
    const mixerPort = parseInt(mixerPortStr, 10);

    console.log(`Orchestratorからの応答: Mixerアドレス ${mixerAddr}`);

    // Mixerに接続してVC接続の命令を送信
    const connection = joinVoiceChannel({
        channelId: interaction.member.voice.channel.id,
        guildId: guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });
    const player = createAudioPlayer();
    connection.subscribe(player);

    // PCMをDiscordに直接流す
    const playStream = new PassThrough();
    const resource = createAudioResource(playStream, { inputType: StreamType.Raw });
    player.play(resource);

    // playStreamsマップに接続情報を保存して、AudioInterfaceのイベントでアクセスできるようにする
    playStreams.set(guildId, { player, playStream });

    connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`VC connection ready for guild ${guildId}`);
        // Mixerに自分の接続情報を通知して、音声データの受信を開始できるようにする
        audioIO.noticeAddressToMixer(mixerIp, mixerPort, unionId, guildId);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.log(`VC connection disconnected for guild ${guildId}`);
        playStreams.delete(guildId);
        audioIO.clearUserSequence(unionId, guildId);
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5000),
            ]);
            console.log(`VC connection reconnected for guild ${guildId}`);
        } catch (error) {
            console.log(`VC connection failed to reconnect for guild ${guildId}, destroying connection`);
            connection.destroy();
        }
    });

    connection.on('error', (error) => {
        console.error(`VC connection error for guild ${guildId}:`, error);
    });

    // 発言中のユーザーを管理するためのMap
    const speakingUsers = new Map();

    connection.receiver.speaking.on('start', (userId) => {
        if (speakingUsers.has(userId)) return; // すでに処理中のユーザーは無視
        const opusStream = connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 500 }
        });

        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

        opusStream.pipe(decoder);
        decoder.on('data', (pcmChunk) => {
            // MixerにPCMデータを送信
            audioIO.sendAudio(mixerIp, mixerPort, unionId, userId, guildId, pcmChunk);
        });

        opusStream.once('end', () => {
            decoder.destroy();
            speakingUsers.delete(userId);
        });

        decoder.on('error', (err) => {
            console.error(`Decoder error (${userId}):`, err);
        });

        speakingUsers.set(userId, { opusStream, decoder });
    });

    await interaction.editReply({
        content: `Union \`${unionId}\` に接続しました。`,
        flags: MessageFlags.Ephemeral
    });
}

audioIO.on('audio', ({ unionId, guildId }) => {
    const session = playStreams.get(guildId); // 既存のセッションを取得する処理
    if (!session || !session.playStream) return;

    // 現在のDiscord.jsのバッファサイズを確認して、必要な数だけPCMデータをplayStreamに書き込む処理
    const jitterBuffer = audioIO.jitterBuffer.get(guildId);
    if (jitterBuffer && jitterBuffer.length > 0) {
        // ジッタバッファから順番にPCMデータを取り出してplayStreamに書き込む
        let canWrite = true;
        while (jitterBuffer.length > 0 && canWrite) {
            const packet = jitterBuffer[0]; // 先頭のパケットを確認
            if (!packet) break;
            canWrite = session.playStream.write(packet.pcmData);
            if (canWrite) {
                jitterBuffer.shift(); // 書き込めたらバッファから削除
            }
            else {
                console.warn(`playStreamのバッファがいっぱいです。PCMデータはジッタバッファに残ります。`);
            }
        }
    } else {
        console.warn(`No audio data in jitter buffer for guild ${guildId}`);
    }
});

function registerSlashCommands(guild) {
    // コマンドを一度すべて削除
    // client.application.commands.set([])
    // guild.commands.set([])
    //     .then(console.log)
    //     .catch(console.error);

    const commandFiles = fs.readdirSync(path.join(fileURLToPath(import.meta.url), '../discordCommands')).filter(file => file.endsWith('.js'));
    async function registerCommands(file) {
        const command = (await import(`./discordCommands/${file}`)).default;
        if (!command.data) return;
        try {
            await guild.commands.create(command.data);
            console.log(`Registered command: ${command.data.name}`);
        } catch (error) {
            console.error(`Error registering command ${command.data.name}:`, error);
        }
    }
    const commandPromises = commandFiles.map(registerCommands);
    Promise.all(commandPromises)
        .then(() => {
            console.log(`All commands registered in ${guild.name}`);
        })
        .catch(error => {
            console.error(`Error registering commands in ${guild.name}:`, error);
        });
    console.log(`Command registration completed in ${guild.name}`);
}

client.login(config.DiscordBotToken);
