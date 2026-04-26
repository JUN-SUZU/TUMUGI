import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('create')
        .setDescription('Create a new Union.')
        .setDescriptionLocalizations({
            'ja': '新しいUnionを作成します。'
        })
        .addStringOption(option =>
            option.setName('unionid')
                .setDescription('The ID of the Union to create. (Must be unique)')
                .setDescriptionLocalizations({
                    'ja': '作成するUnionのID。（一意である必要があります）'
                })
                .setRequired(true))
};
