import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('disband')
        .setDescription('Disband a Union.')
        .setDescriptionLocalizations({
            'ja': 'Unionを解散します。'
        })
        .addStringOption(option =>
            option.setName('unionid')
                .setDescription('The ID of the Union to disband.')
                .setDescriptionLocalizations({
                    'ja': '解散するUnionのID。'
                })
                .setRequired(true))
};
