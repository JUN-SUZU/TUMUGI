import config from './../config.json' with { type: 'json' };
import { Pool } from 'pg';

export class Postgres {
    constructor() {
        this.pool = new Pool({
            user: config.Postgres.User,
            host: config.Postgres.Host,
            database: config.Postgres.Database,
            password: config.Postgres.Password,
            port: config.Postgres.Port,
        });

        /**
         * ユニオン関連のデータベース操作をまとめたオブジェクト
         * @namespace unions
         */
        const unions = {
            /**
             * @typedef {Object} Union
             * @property {string} id ユニオンのID
             * @property {string} leader_guild_id 代表のDiscordサーバーのID
             * @property {string[]} member_guild_ids 参加しているDiscordサーバーのIDの配列
             * @property {string[]} invited_guild_ids 招待されているDiscordサーバーのIDの配列
             */

            /**
             * ユニオンのIDからユニオンを取得する
             * @param {string} id ユニオンのID
             * @returns {Promise<Union|null>} ユニオンの情報
             */
            getByUnionId: async (id) => {
                const res = await this.query('SELECT * FROM unions WHERE union_id = $1', [id]);
                return res?.rows[0] || null;
            },

            /**
             * DiscordサーバーのIDから参加しているユニオンを取得する
             * @param {string} guildId DiscordサーバーのID
             * @returns {Promise<Union[]|null>} 参加しているユニオンの情報の配列
             */
            getByGuildId: async (guildId) => {
                const res = await this.query('SELECT * FROM unions WHERE member_guild_ids @> ARRAY[$1]::varchar[]', [guildId]);
                return res?.rows || [];
            },

            /**
             * DiscordサーバーのIDから招待されているユニオンを取得する
             * @param {string} guildId DiscordサーバーのID
             * @returns {Promise<Union[]|null>} 招待されているユニオンの情報の配列
             */
            getInvitedByGuildId: async (guildId) => {
                const res = await this.query('SELECT * FROM unions WHERE invited_guild_ids @> ARRAY[$1]::varchar[]', [guildId]);
                return res?.rows || [];
            },

            /**
             * ユニオンを形成する
             * @param {string} id 
             * @param {string} leaderGuildId 
             * @returns {Promise<Union|null>} 形成されたユニオンの情報
             */
            formation: async (id, leaderGuildId, passphrase = null) => {
                try {
                    await this.query('INSERT INTO unions (union_id, leader_guild_id, member_guild_ids, passphrase) VALUES ($1, $2, $3, $4) ON CONFLICT (union_id) DO NOTHING',
                        [id, leaderGuildId, [leaderGuildId], passphrase]);
                    return await this.unions.getByUnionId(id);
                } catch (error) {
                    console.error('Postgres formation error:', error);
                    return null;
                };
            },

            /**
             * ユニオンを解散する
             * @param {string} id 
             * @returns {Promise<boolean>} success
             */
            disband: async (id) => {
                try {
                    const res = await this.query('DELETE FROM unions WHERE union_id = $1', [id]);
                    return res.rowCount > 0;
                } catch (error) {
                    console.error('Postgres disband error:', error);
                    return false;
                };
            },

            /**
             * ユニオンに参加するように招待する
             * @param {string} unionId 
             * @param {string} guildId 
             * @returns {Promise<boolean>} success
             */
            invite: async (unionId, guildId) => {
                try {
                    const res = await this.query('UPDATE unions SET invited_guild_ids = array_append(invited_guild_ids, $1) WHERE union_id = $2 AND NOT invited_guild_ids @> ARRAY[$1]::varchar[]',
                        [guildId, unionId]);
                    return res.rowCount > 0;
                } catch (error) {
                    console.error('Postgres invite error:', error);
                    return false;
                };
            },

            /**
             * 招待を取り消す
             * @param {string} unionId 
             * @param {string} guildId 
             * @returns {Promise<boolean>} success
             */
            invokeInvite: async (unionId, guildId) => {
                try {
                    const res = await this.query('UPDATE unions SET invited_guild_ids = array_remove(invited_guild_ids, $1) WHERE union_id = $2',
                        [guildId, unionId]);
                    return res.rowCount > 0;
                } catch (error) {
                    console.error('Postgres invokeInvite error:', error);
                    return false;
                };
            },

            /**
             * ユニオンに招待されているか
             * @param {string} unionId 
             * @param {string} guildId 
             * @returns {Promise<boolean>} isInvited
             */
            isInvited: async (unionId, guildId) => {
                try {
                    const res = await this.query('SELECT * FROM unions WHERE union_id = $1 AND invited_guild_ids @> ARRAY[$2]::varchar[]', [unionId, guildId]);
                    return res.rows.length > 0;
                } catch (error) {
                    console.error('Postgres isInvited error:', error);
                    return false;
                };
            },

            /**
             * パスフレーズが正しいか検証する
             * @param {string} unionId 
             * @param {string} passphrase 
             * @returns {Promise<boolean>} isCorrect
             */
            verifyPassphrase: async (unionId, passphrase) => {
                try {
                    const res = await this.query('SELECT * FROM unions WHERE union_id = $1 AND passphrase = $2', [unionId, passphrase]);
                    return res.rows.length > 0;
                } catch (error) {
                    console.error('Postgres verifyPassphrase error:', error);
                    return false;
                };
            },

            /**
             * ユニオンのパスフレーズを設定または更新する
             * @param {string} unionId 
             * @param {string|null} passphrase 新しいパスフレーズ（nullの場合はパスフレーズを削除）
             * @returns {Promise<boolean>} success
             */
            setPassphrase: async (unionId, passphrase) => {
                try {
                    const res = await this.query('UPDATE unions SET passphrase = $1 WHERE union_id = $2', [passphrase, unionId]);
                    return res.rowCount > 0;
                } catch (error) {
                    console.error('Postgres setPassphrase error:', error);
                    return false;
                };
            },

            /**
             * ユニオンに参加する
             * @param {string} unionId 
             * @param {string} guildId 
             * @returns {Promise<boolean>} success
             */
            join: async (unionId, guildId) => {
                try {
                    // 招待リストに登録してあり、かつまだメンバーでない場合またはパスフレーズが正しい場合のみ参加させる。参加後には招待リストからも削除する。
                    const res = await this.query('UPDATE unions SET member_guild_ids = array_append(member_guild_ids, $1), invited_guild_ids = array_remove(invited_guild_ids, $1) WHERE union_id = $2 AND NOT member_guild_ids @> ARRAY[$1]::varchar[]',
                        [guildId, unionId]);
                    return res.rowCount > 0;
                } catch (error) {
                    console.error('Postgres join error:', error);
                    return false;
                };
            },

            /**
             * ユニオンからメンバーを追放する
             * @param {string} unionId 
             * @param {string} guildId 
             * @returns {Promise<boolean>} success
             */
            expel: async (unionId, guildId) => {
                try {
                    const res = await this.query('UPDATE unions SET member_guild_ids = array_remove(member_guild_ids, $1) WHERE union_id = $2',
                        [guildId, unionId]);
                    return res.rowCount > 0;
                } catch (error) {
                    console.error('Postgres expel error:', error);
                    return false;
                };
            },

            /**
             * リーダー権限を譲渡する
             * @param {string} unionId 
             * @param {string} newLeaderGuildId
             * @returns {Promise<boolean>} success
             */
            handoverLeader: async (unionId, newLeaderGuildId) => {
                try {
                    const res = await this.query('UPDATE unions SET leader_guild_id = $1 WHERE union_id = $2',
                        [newLeaderGuildId, unionId]);
                    return res.rowCount > 0;
                } catch (error) {
                    console.error('Postgres handoverLeader error:', error);
                    return false;
                };
            },

            /**
             * すべてのユニオンを取得する
             * @returns {Promise<Union[]>}
             */
            list: async () => {
                const res = await this.query('SELECT * FROM unions');
                return res?.rows || [];
            }
        }

        const guilds = {
            /**
             * ギルドのIDからギルドを取得する
             * @param {string} id ギルドのID
             * @returns {Promise<Object|null>} ギルドの情報
             */
            getByGuildId: async (id) => {
                const res = await this.query('SELECT * FROM guilds WHERE guild_id = $1', [id]);
                return res?.rows[0] || null;
            },

            /**
             * ギルドを登録する
             * @param {string} id ギルドのID
             * @param {Object} data ギルドの情報
             * @returns {Promise<Object|null>} 登録されたギルドの情報
             */
            register: async (id, data) => {
                try {
                    await this.query('INSERT INTO guilds (guild_id, data) VALUES ($1, $2) ON CONFLICT (guild_id) DO NOTHING',
                        [id, data]);
                    return true;
                } catch (error) {
                    console.error('Postgres register guild error:', error);
                    return false;
                };
            },

            /**
             * ギルドを更新または登録する
             * @param {string} id ギルドのID
             * @param {Object} data ギルドの情報
             * @returns {Promise<Object|null>} 更新または登録されたギルドの情報
             */
            upsert: async (id, data) => {
                try {
                    await this.query('INSERT INTO guilds (guild_id, data) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET data = EXCLUDED.data',
                        [id, data]);
                    return true;
                } catch (error) {
                    console.error('Postgres upsert guild error:', error);
                    return false;
                };
            },

            /**
             * すべてのギルドを取得する
             * @returns {Promise<Object[]>} ギルドの情報の配列
             */
            list: async () => {
                const res = await this.query('SELECT * FROM guilds');
                return res?.rows || [];
            }
        }

        this.unions = unions;
        this.guilds = guilds;
    }
    async query(text, params) {
        const client = await this.pool.connect();
        try {
            const res = await client.query(text, params);
            return res;
        }
        catch (error) {
            console.error('Postgres query error:', error);
            return null;
        }
        finally {
            client.release();
        }
    }
}
