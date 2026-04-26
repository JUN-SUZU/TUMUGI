import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('expel')
        .setDescription('Expel the specified server from Union.')
        .setDescriptionLocalizations({
            'ja': '指定したサーバーをUnionから除名します。'
        })
        .addStringOption(option =>
            option
                .setName('serverid')
                .setNameLocalizations({
                    'ja': 'サーバーid'
                })
                .setDescription('Enter the server ID to expel.')
                .setDescriptionLocalizations({
                    'ja': '除名するサーバーIDを入力してください。'
                })
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('unionid')
                .setNameLocalizations({
                    'ja': 'ユニオンid'
                })
                .setDescription('Enter the Union ID to expel from.')
                .setDescriptionLocalizations({
                    'ja': '除名するユニオンIDを入力してください。'
                })
                .setRequired(true)
        )
};
