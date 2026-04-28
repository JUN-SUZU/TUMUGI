# TUMUGIのセットアップ ~PostgreSQL~

このドキュメントでは、TUMUGIのセットアップに必要なPostgreSQLの設定方法について説明します。

## PostgreSQLのインストール

PostgreSQLがまだインストールされていない場合は、以下のコマンドでインストールしてください。

```bash
sudo apt update && sudo apt upgrade -y && sudo apt install -y postgresql postgresql-contrib
```

## データベースとユーザーの作成

PostgreSQLのインストールが完了したら、TUMUGI用のデータベースとユーザーを作成します。以下のコマンドを実行してください。

```bash
sudo -u postgres psql
```

PostgreSQLのプロンプトが表示されたら、以下のSQLコマンドを実行してデータベースとユーザーを作成します。

```sql
CREATE DATABASE "TUMUGI";
CREATE USER "TUMUGI" WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE "TUMUGI" TO "TUMUGI";
\q
```

```sql
\c "TUMUGI"
```

```sql
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "TUMUGI";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "TUMUGI";
```

- `your_secure_password` は、実際の安全なパスワードに置き換えてください。
- データベース名とユーザー名は、TUMUGIの設定ファイルで指定したものと一致させてください。
- このユーザーはTUMUGIがデータベースにアクセスするために使用されます。適切な権限を付与することが重要です。
- PostgreSQLの設定ファイル（通常は`/etc/postgresql/<version>/main/pg_hba.conf`）で、TUMUGIユーザーが接続できるように設定を確認してください。例えば、ローカル接続を許可するには以下の行が必要です。

```conf
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   TUMUGI          TUMUGI                                  md5
```

## テーブルの初期化

```PostgreSQL
CREATE TABLE IF NOT EXISTS unions (
  union_id VARCHAR(255) PRIMARY KEY,
  leader_guild_id VARCHAR(255) NOT NULL,
  member_guild_ids VARCHAR(255)[] NOT NULL DEFAULT '{}',
  invited_guild_ids VARCHAR(255)[] NOT NULL DEFAULT '{}',
  passphrase VARCHAR(255)
);
CREATE TABLE IF NOT EXISTS guilds (
  guild_id VARCHAR(255) PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'
);
```

## TUMUGIの設定

TUMUGIの設定ファイル（`config.json`）に、PostgreSQLの接続情報を入力してください。

```json
{
  "Postgres": {
    "Host": "localhost",
    "Port": 5432,
    "Database": "TUMUGI",
    "User": "TUMUGI",
    "Password": "your_secure_password"
  },
  // その他の設定項目...
}
```

- `Host`: PostgreSQLサーバーのホスト名（通常は`localhost`）
- `Port`: PostgreSQLのポート番号（デフォルトは5432）
- `Database`: 作成したデータベース名（この例では`TUMUGI`）
- `User`: 作成したユーザー名（この例では`TUMUGI`）
- `Password`: 作成したユーザーのパスワード
- これらの設定は、TUMUGIがPostgreSQLに接続するために必要です。正確に入力してください。
- TUMUGIを起動する前に、PostgreSQLが正しく設定されていることを確認してください。接続テストを行うには、以下のコマンドを使用できます。

```bash
psql -h localhost -U TUMUGI -d TUMUGI
```

以上で、TUMUGIのセットアップに必要なPostgreSQLの設定は完了です。次のステップでは、NATS JetStreamやRedisなどの他の依存サービスの設定に進んでください。
