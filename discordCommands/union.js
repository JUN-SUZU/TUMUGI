import { SlashCommandBuilder } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('union')
        .setDescription('Union management commands')
        .setDescriptionLocalization('ja', 'ユニオン管理コマンド')
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Create a new union')
                .setDescriptionLocalization('ja', '新しいユニオンを作成する')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('The name of the union')
                        .setDescriptionLocalization('ja', 'ユニオンの名前')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('passphrase')
                        .setDescription('A passphrase for the union (optional)')
                        .setDescriptionLocalization('ja', 'ユニオンのパスフレーズ（任意）')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('disband')
                .setDescription('Disband an existing union')
                .setDescriptionLocalization('ja', '既存のユニオンを解散する')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to disband')
                        .setDescriptionLocalization('ja', '解散するユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('transfer')
                .setDescription('Transfer ownership of a union to another guild')
                .setDescriptionLocalization('ja', 'ユニオンの所有権を別のギルドに移す')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to transfer ownership of')
                        .setDescriptionLocalization('ja', '所有権を移すユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('guild')
                        .setDescription('The guild to transfer ownership to')
                        .setDescriptionLocalization('ja', '所有権の移転先のギルド')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('invite')
                .setDescription('Invite a guild to a union')
                .setDescriptionLocalization('ja', 'ギルドをユニオンに招待する')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to invite to')
                        .setDescriptionLocalization('ja', '招待するユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('guild')
                        .setDescription('The guild to invite')
                        .setDescriptionLocalization('ja', '招待するギルド')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('invokeinvite')
                .setDescription('Cancel an invitation to a union')
                .setDescriptionLocalization('ja', 'ユニオンへの招待をキャンセルする')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to cancel the invitation for')
                        .setDescriptionLocalization('ja', '招待をキャンセルするユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('guild')
                        .setDescription('The guild to cancel the invitation for')
                        .setDescriptionLocalization('ja', '招待をキャンセルするギルド')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('kick')
                .setDescription('Kick a guild from a union')
                .setDescriptionLocalization('ja', 'ギルドをユニオンから追放する')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to kick from')
                        .setDescriptionLocalization('ja', '追放するユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('guild')
                        .setDescription('The guild to kick')
                        .setDescriptionLocalization('ja', '追放するギルド')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('list')
                .setDescription('List all unions the current guild is a member of')
                .setDescriptionLocalization('ja', '現在のギルドがメンバーであるすべてのユニオンをリストアップする')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('info')
                .setDescription('Get information about a specific union')
                .setDescriptionLocalization('ja', '特定のユニオンについての情報を取得する')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to get information about')
                        .setDescriptionLocalization('ja', '情報取得するユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('setpassphrase')
                .setDescription('Set or update the passphrase for a union')
                .setDescriptionLocalization('ja', 'ユニオンのパスフレーズを設定または更新する')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to set the passphrase for')
                        .setDescriptionLocalization('ja', 'パスフレーズを設定するユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('passphrase')
                        .setDescription('The new passphrase for the union (leave blank to remove the passphrase)')
                        .setDescriptionLocalization('ja', 'ユニオンの新しいパスフレーズ（空白のままにするとパスフレーズが削除されます）')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('join')
                .setDescription('Join a union using a passphrase')
                .setDescriptionLocalization('ja', 'パスフレーズを使用してユニオンに参加する')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to join')
                        .setDescriptionLocalization('ja', '参加するユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('passphrase')
                        .setDescription('The passphrase for the union (if required)')
                        .setDescriptionLocalization('ja', 'ユニオンのパスフレーズ（必要な場合）')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('leave')
                .setDescription('Leave a union')
                .setDescriptionLocalization('ja', 'ユニオンから退出する')
                .addStringOption(option =>
                    option.setName('union')
                        .setDescription('The name of the union to leave')
                        .setDescriptionLocalization('ja', '退出するユニオンの名前')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
        )
}
