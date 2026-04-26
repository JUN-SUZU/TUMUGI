import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('disconnect')
        .setDescription('Disconnect your VC from a Union.')
        .setDescriptionLocalizations({
            'ja': 'VCをUnionから切断します。'
        })
};
