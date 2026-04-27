import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('vc')
        .setDescription('Voice channel management commands')
        .setDescriptionLocalization('ja', 'ボイスチャンネル管理コマンド')
        .addSubcommand(subcommand =>
            subcommand
                .setName('connect')
                .setDescription('Connect VC to a union')
                .setDescriptionLocalization('ja', 'VCをユニオンに接続する')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to connect to')
                        .setDescriptionLocalization('ja', '接続するユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('disconnect')
                .setDescription('Disconnect VC from the current union')
                .setDescriptionLocalization('ja', 'VCを現在のユニオンから切断する')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Check the current union connection status')
                .setDescriptionLocalization('ja', '現在のユニオン接続状況を確認する')
        )
}
