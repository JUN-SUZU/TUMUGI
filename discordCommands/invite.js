import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Invite other servers to your Union.')
        .setDescriptionLocalizations({
            'ja': '他のサーバーをUnionに招待します。'
        })
        .addStringOption(option =>
            option
                .setName('serverid')
                .setNameLocalizations({
                    'ja': 'サーバーid'
                })
                .setDescription('Enter the server ID to invite.')
                .setDescriptionLocalizations({
                    'ja': '招待するサーバーIDを入力してください。'
                })
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('unionid')
                .setNameLocalizations({
                    'ja': 'ユニオンid'
                })
                .setDescription('Enter the Union ID to invite to.')
                .setDescriptionLocalizations({
                    'ja': '招待するユニオンIDを入力してください。'
                })
                .setRequired(true)
        )
};
