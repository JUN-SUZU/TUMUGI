import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('connect')
        .setDescription('Connect your VC to a Union.')
        .setDescriptionLocalizations({
            'ja': 'VCをUnionに接続します。'
        })
};
