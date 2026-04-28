import config from './config.json' with { type: 'json' };
import fs from 'fs';
import {
    Client, GatewayIntentBits, Partials, ActivityType, MessageFlags, PermissionsBitField, ActionRowBuilder,
    StringSelectMenuBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import {
    joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, VoiceConnectionStatus, entersState, getVoiceConnection,
    EndBehaviorType,
    NoSubscriberBehavior
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
    client.guilds.cache.forEach(async (guild) => {
        registerSlashCommands(guild);
        await pg.guilds.upsert(guild.id, { name: guild.name });
    });
});

client.on('guildCreate', async (guild) => {
    console.log(`Joined new guild: ${guild.name} (ID: ${guild.id})`);
    registerSlashCommands(guild);
    await pg.guilds.upsert(guild.id, { name: guild.name });
});

const chatInputCommandsHandlers = {
    // vcコマンドのサブコマンド
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
        const unionId = interaction.options.getString('union');
        const unionData = await pg.unions.getByUnionId(unionId);
        if (!unionData) {
            return await interaction.reply({
                content: `指定されたUnion ID (${unionId}) は存在しません。`,
                flags: MessageFlags.Ephemeral
            });
        } else if (!unionData.member_guild_ids.includes(interaction.guild.id)) {
            return await interaction.reply({
                content: `Union ${unionId} にこのサーバーは参加していません。`,
                flags: MessageFlags.Ephemeral
            });
        }
        await interaction.reply({
            content: `Union ${unionId} に接続しています...`,
            flags: MessageFlags.Ephemeral
        });
        await connectUnion(interaction, unionId);
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
        // Orchestratorに切断要求を送信
        try {
            const nc = await createJetStream();
            nc.publish(`vc.request.leave`, sc.encode(JSON.stringify({
                unionId: connection.unionId,
                guildId: interaction.guild.id
            })));
        } catch (error) {
            console.error(`VC connection disconnection error for guild ${interaction.guild.id}:`, error);
        }
        await interaction.reply({
            content: "VCから切断しました。",
            flags: MessageFlags.Ephemeral
        });
    },
    'status': async (interaction) => {
        const connection = getVoiceConnection(interaction.guild.id);
        if (!connection) {
            return await interaction.reply({
                content: "現在このサーバーはどのUnionにも接続されていません。",
                flags: MessageFlags.Ephemeral
            });
        }
        /**
         * TODO: 接続されているUnion内のサーバー一覧をOrchestratorに問い合わせて表示する
         */
    },
    // unionコマンドのサブコマンド
    'create': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const unionId = interaction.options.getString('name');
        const passphrase = interaction.options.getString('passphrase') || null;// パスフレーズは任意

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
        const newUnion = await pg.unions.formation(unionId, interaction.guild.id, passphrase);
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
        const unionId = interaction.options.getString('union');
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
    'transfer': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const unionId = interaction.options.getString('union');
        const targetGuildId = interaction.options.getString('guild');
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
        const targetGuildData = await pg.guilds.getByGuildId(targetGuildId);
        if (!targetGuildData) {
            return await interaction.reply({
                content: `指定されたサーバーID (${targetGuildId}) は存在しません。`,
                flags: MessageFlags.Ephemeral
            });
        }
        const result = await pg.unions.transfer(unionId, targetGuildId);
        if (result) {
            await interaction.reply({
                content: `Union ${unionId} をサーバー ${targetGuildId} に移管しました。`,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.reply({
                content: `Union ${unionId} の移管に失敗しました。もう一度やり直してください。このエラーが続く場合は管理者にお問い合わせください。`,
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
        const targetUnionId = interaction.options.getString('union');
        const targetGuildId = interaction.options.getString('guild');

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
        if (unionData.member_guild_ids.includes(targetGuildId)) {
            return await interaction.reply({
                content: `サーバーID: ${targetGuildId} はすでに Union ${targetUnionId} のメンバーです。`,
                flags: MessageFlags.Ephemeral
            });
        }
        const targetGuildData = await pg.guilds.getByGuildId(targetGuildId);
        if (!targetGuildData) {
            return await interaction.reply({
                content: `指定されたサーバーID (${targetGuildId}) は存在しません。`,
                flags: MessageFlags.Ephemeral
            });
        }

        await pg.unions.invite(targetUnionId, targetGuildId);
        await interaction.reply({
            content: `サーバーID: ${targetGuildId} を Union ${targetUnionId} に招待しました。`,
            flags: MessageFlags.Ephemeral
        });
    },
    'invokeinvite': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const targetUnionId = interaction.options.getString('union');
        const targetGuildId = interaction.options.getString('guild');
        // 招待をキャンセルする権限があるか確認する
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
        const targetGuildData = await pg.guilds.getByGuildId(targetGuildId);
        if (!targetGuildData) {
            return await interaction.reply({
                content: `指定されたサーバーID (${targetGuildId}) は存在しません。`,
                flags: MessageFlags.Ephemeral
            });
        }
        const isInvited = await pg.unions.isInvited(targetUnionId, targetGuildId);
        if (!isInvited) {
            return await interaction.reply({
                content: `サーバーID: ${targetGuildId} は Union ${targetUnionId} に招待されていません。`,
                flags: MessageFlags.Ephemeral
            });
        }
        await pg.unions.invokeInvite(targetUnionId, targetGuildId);
        await interaction.reply({
            content: `サーバーID: ${targetGuildId} の招待をキャンセルしました。`,
            flags: MessageFlags.Ephemeral
        });
    },
    'kick': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const targetUnionId = interaction.options.getString('union');
        const targetGuildId = interaction.options.getString('guild');

        // 追放する権限があるか確認する
        if (interaction.guildId === targetGuildId) {
            return await interaction.reply({
                content: "あなたは自分のサーバーを追放することはできません。",
                flags: MessageFlags.Ephemeral
            });
        }
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
    },
    'list': async (interaction) => {
        // このサーバーが参加しているユニオンの一覧を表示する
        const unions = await pg.unions.getByGuildId(interaction.guild.id);
        if (!unions || unions.length === 0) {
            return await interaction.reply({
                content: "このサーバーはどのユニオンにも参加していません。",
                flags: MessageFlags.Ephemeral
            });
        }
        const unionList = unions.map(union => union.union_id).join(', ');
        await interaction.reply({
            content: `このサーバーが参加しているユニオン:\n${unionList}`,
            flags: MessageFlags.Ephemeral
        });
    },
    'info': async (interaction) => {
        // 指定されたユニオンの情報を表示する
        const unionId = interaction.options.getString('union');
        const unionData = await pg.unions.getByUnionId(unionId);
        if (!unionData) {
            return await interaction.reply({
                content: `指定されたUnion ID (${unionId}) は存在しません。`,
                flags: MessageFlags.Ephemeral
            });
        }
        const leaderGuild = await pg.guilds.getByGuildId(unionData.leader_guild_id);
        const memberGuilds = await Promise.all(
            unionData.member_guild_ids.map(guildId => pg.guilds.getByGuildId(guildId))
        );
        const invitedGuilds = await Promise.all(
            unionData.invited_guild_ids.map(guildId => pg.guilds.getByGuildId(guildId))
        );
        const infoEmbed = new EmbedBuilder()
            .setTitle(`Union ${unionId} の情報`)
            .addFields(
                { name: 'リーダーサーバー', value: leaderGuild ? leaderGuild.name : '不明', inline: true },
                { name: 'メンバーサーバー', value: memberGuilds.length > 0 ? memberGuilds.map(g => g.name).join('\n') : 'なし', inline: true },
                { name: '招待中のサーバー', value: invitedGuilds.length > 0 ? invitedGuilds.map(g => g.name).join('\n') : 'なし', inline: true },
                { name: 'パスフレーズ', value: unionData.passphrase ? unionData.passphrase : 'なし' }
            )
            .setColor(basecolor);
        await interaction.reply({ embeds: [infoEmbed], flags: MessageFlags.Ephemeral });
    },
    'setpassphrase': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }
        const unionId = interaction.options.getString('union');
        const passphrase = interaction.options.getString('passphrase');
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
        if (Buffer.byteLength(passphrase, 'utf-8') > 32 || !passphrase.match(/^[a-zA-Z0-9_-]*$/)) {
            return await interaction.reply({
                content: "パスフレーズはUTF-8で32バイト以内の英数字、アンダースコア、ハイフンのみを使用できます。",
                flags: MessageFlags.Ephemeral
            });
        }
        const result = await pg.unions.setPassphrase(unionId, passphrase);
        if (result) {
            await interaction.reply({
                content: `Union ${unionId} のパスフレーズを設定しました。`,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.reply({
                content: `Union ${unionId} のパスフレーズの設定に失敗しました。もう一度やり直してください。このエラーが続く場合は管理者にお問い合わせください。`,
                flags: MessageFlags.Ephemeral
            });
        }
    },
    'join': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }

        // Union名をコマンドの引数から取得
        const unionId = interaction.options.getString('union');
        const passphrase = interaction.options.getString('passphrase') || null;// パスフレーズは任意
        const guildId = interaction.guild.id;

        if (passphrase) {
            // パスフレーズが一致しているなら招待されていなくても参加を許可する
            const isCorrect = await pg.unions.verifyPassphrase(unionId, passphrase);
            if (!isCorrect) {
                return await interaction.reply({
                    content: `Union ${unionId} への参加に失敗しました。パスフレーズが正しいか確認してください。`,
                    flags: MessageFlags.Ephemeral
                });
            }
        } else {
            // パスフレーズが指定されていない場合、招待されているか確認する
            const isInvited = await pg.unions.isInvited(unionId, guildId);
            if (!isInvited) {
                return await interaction.reply({
                    content: `Union ${unionId} への参加に失敗しました。招待されているUnionか確認してください。`,
                    flags: MessageFlags.Ephemeral
                });
            }
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
    'leave': async (interaction) => {
        if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: "あなたはこのサーバーの管理者権限を持っている必要があります。",
                flags: MessageFlags.Ephemeral
            });
        }

        // Union名をコマンドの引数から取得
        const unionId = interaction.options.getString('union');
        const guildId = interaction.guild.id;

        const unionData = await pg.unions.getByUnionId(unionId);
        if (!unionData) {
            return await interaction.reply({
                content: `指定されたUnion ID (${unionId}) は存在しません。`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (unionData.leader_guild_id === guildId) {
            return await interaction.reply({
                content: "リーダーサーバーはUnionから脱退できません。Unionを解散するか、リーダー権限を譲渡してから脱退してください。",
                flags: MessageFlags.Ephemeral
            });
        }

        // Unionから脱退する
        const result = await pg.unions.expel(unionId, guildId);
        if (result) {
            await interaction.reply({
                content: `Union ${unionId} から脱退しました。`,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.reply({
                content: `Union ${unionId} からの脱退に失敗しました。もう一度やり直してください。このエラーが続く場合は管理者にお問い合わせください。`,
                flags: MessageFlags.Ephemeral
            });
        }
    }
}

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            // コマンドを実行する前に、チャンネルの権限を確認する
            const permissions = interaction.channel.permissionsFor(client.user);
            if (!permissions ||
                !permissions.has(PermissionsBitField.Flags.SendMessages) ||
                !permissions.has(PermissionsBitField.Flags.ViewChannel)) {
                return await interaction.reply({
                    content: "チャンネルの権限が不足しています。必要な権限: メッセージの送信、チャンネルの閲覧",
                    flags: MessageFlags.Ephemeral
                });
            }

            // サブコマンド名を取得してルーティングする
            const subcommandName = interaction.options.getSubcommand();
            const execute = chatInputCommandsHandlers[subcommandName];

            if (execute) {
                await execute(interaction);
            } else {
                console.warn(`未実装のサブコマンドが呼ばれました: ${subcommandName}`);
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
        } else if (interaction.isAutocomplete()) {
            // Handle autocomplete interactions
            const focusedOption = interaction.options.getFocused(true);
            const commandName = interaction.commandName;

            if (focusedOption.name === 'union') {
                const unions = await pg.unions.getByGuildId(interaction.guild.id);
                let filteredUnions = unions.filter(union => union.union_id.includes(focusedOption.value));
                const subcommand = interaction.options.getSubcommand();
                const leaderOnlySubcommands = ['disband', 'transfer', 'invite', 'invokeinvite', 'kick', 'setpassphrase'];
                if (leaderOnlySubcommands.includes(subcommand)) {
                    // リーダーサーバーのUnionのみ表示するフィルタリング
                    filteredUnions = filteredUnions.filter(union => union.leader_guild_id === interaction.guild.id);
                }
                if (interaction.options.getSubcommand() === 'join') {
                    // 参加コマンドの場合は、招待されているUnionのみ表示する
                    const invitedUnions = await pg.unions.getInvitedByGuildId(interaction.guild.id);
                    filteredUnions = invitedUnions.filter(union => union.union_id.includes(focusedOption.value));
                }
                const options = filteredUnions.slice(0, 25).map(union => ({
                    name: union.union_id,
                    value: union.union_id
                }));
                await interaction.respond(options.slice(0, 25));
            } else if (focusedOption.name === 'guild') {
                // invite, invokeinvite などのサブコマンドで、Unionに所属していないギルドを選択するオプション
                // kick, transfer などのサブコマンドで、Unionに所属しているギルドを選択するオプション
                const union = interaction.options.getString('union');
                if (!union) {
                    return await interaction.respond([]);
                }
                const unionData = await pg.unions.getByUnionId(union);
                if (!unionData) {
                    return await interaction.respond([]);
                }
                const subcommand = interaction.options.getSubcommand();
                let guildIds = [];
                if (subcommand === 'invite') {
                    // inviteコマンドの場合は、Unionに所属していないギルドを表示する
                    const allGuilds = await pg.guilds.list();
                    guildIds = allGuilds.filter(guild => !unionData.member_guild_ids.includes(guild.guild_id)).map(guild => guild.guild_id);
                }
                else if (subcommand === 'invokeinvite') {
                    // invokeinviteコマンドの場合は、招待リストに入っているギルドを表示する
                    guildIds = unionData.invited_guild_ids || [];
                }
                else if (subcommand === 'kick' || subcommand === 'transfer') {
                    // kick, transferコマンドの場合は、Unionに所属しているギルドを表示する（自分のサーバーは除外）
                    guildIds = unionData.member_guild_ids.filter(id => id !== interaction.guild.id);
                }
                guildIds = guildIds.filter(id => id.includes(focusedOption.value));
                const guildOptions = guildIds.map(guildId => ({
                    name: guildId,
                    value: guildId
                }));
                await interaction.respond(guildOptions.slice(0, 25));
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
    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause,
        }
    });
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

        opusStream.on('error', (err) => {
            console.error(`Opus stream error (${userId}):`, err);
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
