# TUMUGI

TUMUGIはDiscordの音声集約BOTです。同盟内のサーバー間でVCをつなぐことができます。

## できること

- 複数のDiscordサーバーを1つのUnionとしてまとめ、VC音声を相互接続します。
- Union単位で音声を中継し、参加サーバー間で同じVC体験を共有できます。
- Orchestrator, Mixer, Bot を分離して、音声処理と状態管理を役割ごとに分担します。

## 用語

- Union: 複数のDiscordサーバーを束ねる単位です。
- leader guild: Unionの代表サーバーです。招待や除名などの管理操作の基準になります。
- member guild: Unionに参加しているサーバーです。
- invite: Unionへの参加招待です。

## 必要なもの

- Node.js 18以上
- PostgreSQL
- NATS JetStream
- Redis
- FFmpeg
- Discord Bot Token

## 初期設定

1. `config.example.json` を `config.json` にコピーして、環境に合わせて編集します。
2. PostgreSQL に `TUMUGI` データベースと `TUMUGI` ユーザーを用意します。
3. NATS JetStream と Redis を起動します。
4. Discord Bot を作成し、必要な権限を付与します。

## 設定項目

`config.json` には少なくとも次の項目が必要です。

- `DiscordBotToken`: Discord Bot のトークン
- `Postgres.Host`: PostgreSQL のホスト名
- `Postgres.Port`: PostgreSQL のポート
- `Postgres.Database`: データベース名
- `Postgres.User`: 接続ユーザー名
- `Postgres.Password`: パスワード
- `audioInterfacePort`: Mixer と通信する UDP ポート
- `nats.servers`: NATS の接続先一覧

## 起動順序

1. PostgreSQL
2. NATS JetStream
3. Redis
4. Orchestrator
5. Mixer
6. Bot

## コマンド一覧

### connect

- 役割: 現在参加しているVCをUnionに接続します。
- 前提: 実行時にユーザーがVCへ参加している必要があります。
- 権限: Bot に `接続`, `発言`, `チャンネルの閲覧` が必要です。

### disconnect

- 役割: VCとの接続を解除し、Bot を退席させます。

### create unionid

- 役割: 指定したIDで新しいUnionを作成します。
- 引数: `unionid` で作成するUnionのIDを指定します。
- 権限: Bot を実行しているサーバーの管理者権限が必要です。
- 注意: Union ID は一意である必要があります。既に存在するIDを指定した場合はエラーになります。
- 注意: Union ID はUTF-8で16バイト以内である必要があります。

### disband unionid

- 役割: 指定したUnionを解散します。
- 引数: `unionid` で解散するUnionのIDを指定します。
- 権限: Unionの leader guild で管理者権限を持つユーザーのみが実行できます。

### invite serverid unionid

- 役割: 指定したサーバーをUnionへ招待します。
- 引数: `serverid` で招待先サーバーIDを指定します。
- 権限: Unionの leader guild で管理者権限を持つユーザーのみが実行できます。

### join unionid

- 役割: 招待を受けてUnionへ参加します。
- 引数: `unionid` でUnion IDを指定します。
- 前提: 事前の招待が必要です。
- 権限: 操作するユーザーが参加しているサーバーの管理者権限が必要です。

### expel serverid unionid

- 役割: 指定したサーバーをUnionから除名します。
- 引数: `unionid` でUnion IDを指定します。
- 引数: `serverid` を省略した場合は自身のサーバーを除名します。
- 権限: 他サーバーを除名する場合は、leader guild で管理者権限を持つユーザーのみが実行できます。
        自身のサーバーを除名する場合は、操作するユーザーが参加しているサーバーの管理者権限が必要です。

## 動作の流れ

1. Bot が Discord の VC に参加します。
2. Bot が Orchestrator に接続要求を送ります。
3. Orchestrator が Union と Mixer の状態を確認し、担当 Mixer を決定します。
4. Bot が Mixer に音声を送受信します。
5. Mixer は Union 単位で音声を中継します。

## 権限と注意事項

- Bot には対象チャンネルへの接続権限が必要です。
- Bot には対象チャンネルでの発言権限が必要です。
- Bot には対象チャンネルの閲覧権限が必要です。
- 同一ユーザーの複数デバイス接続は guildId と userId を識別子として扱うため、問題なく別々の接続として処理されます。
- 音声処理には UDP 通信と PCM / Opus 変換が使われます。

## トラブルシューティング

- 接続できない場合は、PostgreSQL, NATS, Redis の起動状況を確認してください。
- VC 接続に失敗する場合は、Bot の接続権限と発言権限を確認してください。
- 音声が流れない場合は、Mixer と AudioInterface の通信先ポートを確認してください。
- Orchestrator が応答しない場合は、NATS の接続先設定を確認してください。

## 使用技術

- NATS JetStream サーバー間のPub/Subメッセージング
- KVS 状態管理 サーバー間の接続状態を管理
- RPC 音声のコンポーネント間の厳密な型定義と双方向ストリーミング通信
- FFmpeg
- PCM
- Opus

### 開発メモ

- 現状はテスト用データを含む箇所があります。
- コマンドの詳細な制約は実装側の更新に合わせて README も更新してください。

## ライセンス

MIT License

## 開発者

JUN-SUZU

## コントリビューター

### AzOwata

- 2026/04
- 主にBotのインタラクティブなコマンドの実装を担当し、権限確認などのロジックも実装しました。
