import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join a new Union. (Invitation required)')
        .setDescriptionLocalizations({
            'ja': '新しいUnionに加入します。(招待が必要です)'
        })
        .addStringOption(option =>
            option
                .setName('unionid')
                .setNameLocalizations({
                    'ja': 'ユニオンid'
                })
                .setDescription('Enter the ID of the Union.')
                .setDescriptionLocalizations({
                    'ja': 'UnionのIDを入力してください。'
                })
                .setRequired(true)
        )
};
