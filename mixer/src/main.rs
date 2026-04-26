use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::UdpSocket;
use tokio::sync::RwLock;
use tokio::time::{Duration, Instant, interval};

const MAGIC_NUMBER: u32 = 0x54554D4D; // "TUMM"
const VERSION: u8 = 0x01;
const TYPE_AUDIO: u8 = 0x00;
const TYPE_NOTICE: u8 = 0x01;
const NOTICE_HEADER_SIZE: usize = 30; // アドレス通知パケットのヘッダーサイズ(Union IDとGuild IDを含む)
const RECEIVE_HEADER_SIZE: usize = 44; // 受信パケットのヘッダーサイズ(User IDを含む)
const SEND_HEADER_SIZE: usize = 36; // 送信パケットのヘッダーサイズ(User IDを含まない)
const PCM_SAMPLES: usize = 1920; // 48000Hz * 0.02s = 960 samples, ステレオなので 960 * 2 = 1920 samples, 16bitなので 1920 * 2 = 3840 bytes
const PORT: u16 = 40000; // UDPの受信ポート
const NATS_URL: &str = "nats://localhost:4222"; // NATSサーバーのURL
const RING_BUFFER_SIZE: usize = 64; // 各ユーザーのリングバッファサイズ 必ず2のべき乗である必要があります(例: 64, 128, 256など)
const _: () = assert!(
    RING_BUFFER_SIZE.is_power_of_two(),
    "RING_BUFFER_SIZE must be a power of 2"
);
const RING_BUFFER_MASK: usize = RING_BUFFER_SIZE - 1; // インデックスをRING_BUFFER_SIZEで割る代わりにビットマスクで高速化するためのマスク値
const BASE_DELAY: u64 = 40; // ベースとなる遅延時間(ms) ジッタの推定値にこれを加算して目標再生開始時刻を決定する
const SAFETY_COEFFICIENT: u8 = 2; // パケットロスを考慮した安全係数 推奨: 2~4
// 状態管理用のデータ構造
// Union -> Guild -> User -> (PCMデータ, 送信元アドレス)
type UnionId = String; // Guildをまとめる単位としてのUnion IDは16バイトの文字列（null終端も含めて16バイト固定）
type GuildId = u64; // DiscordのGuild IDは64ビット整数
type UserId = u64; // DiscordのUser IDも64ビット整数

#[derive(Serialize)]
struct HeartbeatPayload {
    id: String,
    addr: String,
    load: u32,
}

// Unionの状態を管理するための共有構造体
type SharedTopology = Arc<RwLock<HashMap<String, Vec<(u64, Option<SocketAddr>)>>>>; // Union ID -> Vec<(Guild ID, Guild Address)> のマップ

#[derive(Deserialize, Debug)]
struct ControlMessage {
    action: String,
    #[serde(rename = "unionId")]
    union_id: String,
    guilds: Option<Vec<String>>,
}

#[derive(Clone)]
struct AudioPacket {
    seq: u16,               // 受信したパケットのシーケンス番号（順序管理用）
    pcm: Vec<i16>,          // 計算しやすいようにi16に変換して保持
    elapsed_time: Duration, // 送信時刻と受信時刻の差分（ジッタ管理用）
    addr: SocketAddr,       // 送信元アドレス（返信用）
}

#[derive(Clone, Debug)]
enum UserStatus {
    Active,       // アクティブに音声を送信している状態
    Pending,      // 最初のパケットを受信してから目標再生開始時刻を待っている状態
    Disconnected, // 一定時間パケットが受信されないなどの理由で切断された状態(次回ミキシング処理でクリーンアップされる)
}

struct UserSession {
    pub ring_buffer: Option<Vec<Vec<i16>>>, // シーケンス番号をキーとして PCMデータを保持するリングバッファ サイズはRING_BUFFER_SIZEで固定
    pub prev_elapsed_time: Option<Duration>, // 前回のパケットの送受信時間差（ジッタの更新に使用）
    pub jitter: u32, // ジッタの推定値（ms）。リングバッファの最後に受信したパケットの送受信時間差をもとに更新していく
    pub target_begin_time: Option<Instant>, // 目標とする再生開始時刻。これを過ぎて初めてリングバッファからパケットを取り出してミキシングに参加させる。
    pub next_expected_seq: Option<u16>, // 次に期待するシーケンス番号。最初はNoneで、最初のパケットが来たときにセットされる
    pub final_received_at: Instant, // 最後にパケットを受信した時刻。これをもとに古いセッションをクリーンアップする
    pub status: UserStatus,         // ユーザーの状態（例: Active, Pending, Disconnectedなど）
    pub failed_attempts: u8, // パケットの受信に失敗した回数。これをもとにセッションを切断するなどのロジックを追加する
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // UDPソケットのバインド（Arcで包んで送受信用にクローン可能にする）
    let socket = Arc::new(UdpSocket::bind(format!("0.0.0.0:{}", PORT)).await?);
    println!("[Mixer] UDP Server listening on port {}", PORT);

    let nats_client = async_nats::connect(NATS_URL).await?;
    println!("[Mixer] Connected to NATS");

    let nats_for_hb = nats_client.clone();
    let mixer_id = "Mixer-Rust-1".to_string(); // 一意のID
    // EdgeからアクセスできるIPアドレスを指定します（ローカルテストなら127.0.0.1など）
    let mixer_addr = format!("127.0.0.1:{}", PORT);

    let nats_for_sub = nats_client.clone();
    let topology: SharedTopology = Arc::new(RwLock::new(HashMap::new()));
    let topo_for_sub = Arc::clone(&topology);
    let control_subject = format!("mixer.control.{}", mixer_id);

    let (pcm_tx, mut pcm_rx) =
        tokio::sync::mpsc::channel::<(UnionId, GuildId, UserId, AudioPacket)>(4096);
    let tx_for_recv = pcm_tx.clone();

    let (addr_notice_tx, mut addr_notice_rx) = tokio::sync::mpsc::channel::<(UnionId, GuildId)>(1024);

    // Nats経由Orchestratorへのハートビート送信用のタスク
    tokio::spawn(async move {
        let mut hb_interval = interval(Duration::from_secs(5));
        loop {
            hb_interval.tick().await;

            // TODO: 本来はCPU使用率や現在のUnion接続数を計算して入れます
            // 今回はダミー値として負荷(load)を 10 としています
            let payload = HeartbeatPayload {
                id: mixer_id.clone(),
                addr: mixer_addr.clone(),
                load: 10,
            };

            // 構造体をJSON文字列に変換
            if let Ok(json_str) = serde_json::to_string(&payload) {
                // NATSの "mixer.heartbeat" サブジェクトへPublish
                let _ = nats_for_hb
                    .publish("mixer.heartbeat", json_str.into())
                    .await;
            }
        }
    });

    // Nats経由OrchestratorからのUnion管理メッセージ受信用のタスク
    tokio::spawn(async move {
        let mut subscriber = match nats_for_sub.subscribe(control_subject.clone()).await {
            Ok(sub) => sub,
            Err(e) => {
                eprintln!("[Mixer] サブスクライブに失敗しました: {}", e);
                return;
            }
        };

        println!(
            "[Mixer] Listening for control messages on {}",
            control_subject
        );

        // メッセージが届くたびに非同期でループが回る
        while let Some(msg) = subscriber.next().await {
            // バイト列をUTF-8文字列に変換
            if let Ok(json_str) = std::str::from_utf8(&msg.payload) {
                // 文字列を ControlMessage 構造体にパース
                if let Ok(control) = serde_json::from_str::<ControlMessage>(json_str) {
                    // 状態を書き換えるため、RwLockの書き込みロックを取得
                    let mut topo_write = topo_for_sub.write().await;

                    println!("[Mixer] Received control message: {:?}", control);

                    match control.action.as_str() {
                        "UPDATE_UNION" => {
                            if let Some(guild_strs) = control.guilds {
                                let guild_id_and_addrs: Vec<(u64, Option<SocketAddr>)> = guild_strs
                                    .iter()
                                    .filter_map(|s| s.parse::<u64>().ok())
                                    .map(|guild_id| (guild_id, None)) // ここではアドレスはまだ不明なのでNoneで初期化
                                    .collect();
                                // Unionに紐づく有効なGuildリストを更新
                                topo_write.insert(control.union_id, guild_id_and_addrs);
                            }
                        }
                        "DESTROY_UNION" => {
                            // Unionをトポロジーから削除
                            topo_write.remove(&control.union_id);
                        }
                        _ => {}
                    }
                } else {
                    eprintln!("[Mixer] JSONのパースに失敗しました: {}", json_str);
                }
            }
        }
    });

    // 受信タスクとミキシングタスク用にクローン
    let topo_for_mix = Arc::clone(&topology);
    let socket_for_recv = Arc::clone(&socket);
    let socket_for_mix = Arc::clone(&socket);
    let topo_for_notice = Arc::clone(&topology);

    // 1. 【受信タスク】UDPパケットを受け取り、状態を更新する
    // Ingress
    tokio::spawn(async move {
        let mut buf = [0u8; 4096]; // 4096バイトの受信バッファ（ヘッダー + PCMデータが収まるサイズ）
        loop {
            if let Ok((len, addr)) = socket_for_recv.recv_from(&mut buf).await {
                if len == NOTICE_HEADER_SIZE {
                    // アドレス通知パケットの処理
                    let magic = u32::from_be_bytes(buf[0..4].try_into().unwrap());
                    let version = buf[4];
                    let msg_type = buf[5];

                    if magic != MAGIC_NUMBER || version != VERSION || msg_type != TYPE_NOTICE {
                        continue;
                    }

                    let union_bytes = &buf[6..22];
                    let union_id = String::from_utf8_lossy(union_bytes)
                        .trim_matches(char::from(0))
                        .to_string();

                    let guild_id = u64::from_be_bytes(buf[22..30].try_into().unwrap());

                    // トポロジーを更新するために書き込みロックを取得
                    let mut topo_write = topo_for_notice.write().await;
                    if let Some(guilds) = topo_write.get_mut(&union_id) {
                        if let Some((_, addr_opt)) =
                            guilds.iter_mut().find(|(valid_g_id, _)| valid_g_id == &guild_id)
                        {
                            *addr_opt = Some(addr);
                        }
                    }

                    // チャネルにアドレス通知を送る（必要に応じてミキシングタスクで処理できるようにするため）
                    if let Err(e) = addr_notice_tx.try_send((union_id, guild_id)) {
                        eprintln!("[Mixer] アドレス通知の送信に失敗しました: {}", e);
                    }

                    continue; // アドレス通知パケットはこれ以上処理しない
                }
                if len < RECEIVE_HEADER_SIZE {
                    // ヘッダーが含まれていない不正なパケットは無視
                    continue;
                }

                // ヘッダー解析
                let magic = u32::from_be_bytes(buf[0..4].try_into().unwrap());
                let version = buf[4];
                let msg_type = buf[5];

                if magic != MAGIC_NUMBER || version != VERSION || msg_type != TYPE_AUDIO {
                    continue;
                }

                // 文字列のパース（null終端の除去）
                let union_bytes = &buf[6..22];
                let union_id = String::from_utf8_lossy(union_bytes)
                    .trim_matches(char::from(0))
                    .to_string();

                let user_id = u64::from_be_bytes(buf[22..30].try_into().unwrap());
                let guild_id = u64::from_be_bytes(buf[30..38].try_into().unwrap());
                let sequence_number = u16::from_be_bytes(buf[38..40].try_into().unwrap());
                let send_time = u16::from_be_bytes(buf[40..42].try_into().unwrap());
                let pcm_len = u16::from_be_bytes(buf[42..44].try_into().unwrap()) as usize;

                if len != RECEIVE_HEADER_SIZE + pcm_len {
                    // ヘッダーに書かれたペイロード長と実際の受信長が一致しない場合は無視
                    continue;
                }

                // バイト列(u8)を音声波形(i16リトルエンディアン)に変換
                let pcm_u8 = &buf[RECEIVE_HEADER_SIZE..RECEIVE_HEADER_SIZE + pcm_len];
                let pcm_i16: Vec<i16> = pcm_u8
                    .chunks_exact(2)
                    .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
                    .collect();

                print_waveform(&pcm_i16);

                let packet = AudioPacket {
                    seq: sequence_number,
                    pcm: pcm_i16.clone(),
                    // send_time: estimate_packet_instant(send_time), // 送信時刻を推定
                    // recv_time: Instant::now(),                     // 受信時刻
                    elapsed_time: estimate_packet_instant(send_time).duration_since(Instant::now()), // 送信時刻と受信時刻の差分
                    addr,
                };

                if let Err(e) = tx_for_recv.try_send((union_id, guild_id, user_id, packet)) {
                    eprintln!("[Mixer] PCMデータの送信に失敗しました: {}", e);
                }
            }
        }
    });

    // 2. 【ミキシングタスク】10msごとに全Unionを計算し、マイナスワンで送り返す
    // Egress
    tokio::spawn(async move {
        let mut local_state: HashMap<UnionId, HashMap<GuildId, HashMap<UserId, UserSession>>> =
            HashMap::new();

        let mut outgoing_seq_map: HashMap<UnionId, u16> = HashMap::new();

        let mut interval = tokio::time::interval(std::time::Duration::from_millis(20));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;

            {
                // トポロジーHashMapから、現在有効なUnionとGuildの組み合わせを読み取り、local_stateから存在しないUnionやGuildを削除する
                let topo_read = topo_for_mix.read().await;
                for (u_id, union_buf) in local_state.iter_mut() {
                    if let Some(valid_guilds) = topo_read.get(u_id) {
                        union_buf.retain(|g_id, _| {
                            valid_guilds
                                .iter()
                                .any(|(valid_g_id, _)| valid_g_id == g_id)
                        });
                    }
                }
            }

            // アドレス通知チャネルからの通知を処理してlocal_stateにguildを追加するループ
            while let Ok((u_id, g_id)) = addr_notice_rx.try_recv() {
                let union = local_state.entry(u_id.clone()).or_default();
                union.entry(g_id.clone()).or_default();
            }

            // チャネルから受信したPCMデータをlocal_stateに反映させるループ
            while let Ok((u_id, g_id, user_id, packet)) = pcm_rx.try_recv() {
                let guild = local_state
                    .entry(u_id.clone())
                    .or_default()
                    .entry(g_id.clone())
                    .or_default();

                let session = guild.entry(user_id).or_insert_with(|| UserSession {
                    ring_buffer: Some(vec![vec![0i16; PCM_SAMPLES]; RING_BUFFER_SIZE]), // 最初は空のPCMデータで初期化
                    prev_elapsed_time: Option::Some(std::time::Duration::from_millis(0)), // 最初は前回の差分時間がないので0で初期化
                    jitter: 0,                         // 最初はジッタ0で初期化
                    target_begin_time: None, // 最初は目標再生開始時刻がないのでNoneで初期化
                    next_expected_seq: None, // 最初の一歩は届いたパケットに合わせる
                    final_received_at: Instant::now(), // 最初のパケット受信時刻をセット
                    status: UserStatus::Pending, // 最初はPending状態で開始
                    failed_attempts: 0,      // 最初は失敗回数0で初期化
                });

                // 受信したパケットのシーケンス番号をもとに、リングバッファのどこに保存するかをRING_BUFFER_SIZEで割った余りで決定
                let sequencial_index = packet.seq as usize & RING_BUFFER_MASK;

                // リングバッファに保存する
                if let Some(ring_buffer) = &mut session.ring_buffer {
                    ring_buffer[sequencial_index] = packet.pcm;
                }

                // 次に期待するシーケンス番号がない場合は、最初のパケットのシーケンス番号を次に期待するシーケンス番号としてセット
                if session.next_expected_seq.is_none() {
                    session.next_expected_seq = Some(packet.seq);
                }

                // ジッタの更新（単純な移動平均で更新していく例
                if let Some(prev_elapsed) = session.prev_elapsed_time {
                    let diff_elapsed_time: u64 = (packet.elapsed_time.as_millis() as i64
                        - prev_elapsed.as_millis() as i64)
                        .abs() as u64;
                    session.jitter = ((session.jitter as u64 * 15 + diff_elapsed_time) >> 4) as u32; // ジッタの移動平均更新(16で割る)
                    session.prev_elapsed_time = Some(packet.elapsed_time);
                }

                // 目標遅延時間の更新（ジッタの2倍 + ベース遅延）
                if matches!(session.status, UserStatus::Pending)
                    && session.target_begin_time.is_none()
                {
                    let target_delay_ms =
                        BASE_DELAY + (session.jitter as u64 * SAFETY_COEFFICIENT as u64);
                    let now = Instant::now();
                    session.target_begin_time = Some(now + Duration::from_millis(target_delay_ms));
                }

                // パケットを受信した時刻を更新
                session.final_received_at = Instant::now();

                // Guildの送信元アドレスを確認して、一致しなければ更新する（これにより、最初のパケットを受信したときにアドレスがわかる）
                let mut needs_update = false;
                {
                    // RwLockの負荷が大きいため読み込みだけロックして確認する
                    let topo_read = topo_for_mix.read().await;
                    if let Some(guilds) = topo_read.get(&u_id) {
                        if let Some((_, addr_opt)) =
                            guilds.iter().find(|(valid_g_id, _)| valid_g_id == &g_id)
                        {
                            // Noneの場合、またはアドレスが変更されている場合に更新フラグを立てる
                            if addr_opt.map_or(true, |addr| addr != packet.addr) {
                                needs_update = true;
                            }
                        }
                    }
                }

                // 必要に応じて書き込みロックを取得してアドレスを更新する
                if needs_update {
                    let mut topo_write = topo_for_mix.write().await;
                    if let Some(guilds) = topo_write.get_mut(&u_id) {
                        if let Some((_, addr_opt)) = guilds
                            .iter_mut()
                            .find(|(valid_g_id, _)| valid_g_id == &g_id)
                        {
                            *addr_opt = Some(packet.addr);
                        }
                    }
                }
            }

            // local_stateをもとに、Unionごとにミキシングを行い、ギルドごとにマイナスワンで送り返すループ
            for (union_id, union_buffer) in local_state.iter_mut() {
                if union_buffer.is_empty() {
                    continue;
                }
                // 合成波形を保存するバッファ(後で送信先ギルドの分を引くため、i16の和を保存できるようにi32で確保)
                let mut union_sum = [0i32; PCM_SAMPLES];
                // ギルドごとの合成波形を保存するマップ(後でマイナスワンでクリップして送信するため、i16の和を保存できるようにi32で確保)
                let mut guild_sums: HashMap<GuildId, [i32; PCM_SAMPLES]> =
                    HashMap::with_capacity(union_buffer.len());
                // Unionに紐づく全Guildをループ
                for (guild_id, guild_buffer) in union_buffer.iter_mut() {
                    // Guildの合成波形を保存するバッファ
                    let mut guild_sum = [0i32; PCM_SAMPLES];

                    // Guildに紐づく全Userをループ
                    for (_user_id, session) in guild_buffer.iter_mut() {
                        // 一定時間パケットが受信されないユーザーは切断されたとみなしてセッションをクリーンアップする
                        if session.final_received_at.elapsed() > Duration::from_secs(30) {
                            // セッションをクリーンアップ
                            session.ring_buffer = None;
                            session.next_expected_seq = None;
                            session.target_begin_time = None;
                            session.status = UserStatus::Disconnected;
                            session.failed_attempts = 0;
                            continue;
                        }
                        // 目標再生開始時刻を過ぎているユーザーのみミキシングに参加させる
                        if session
                            .target_begin_time
                            .map_or(true, |t| Instant::now() < t)
                        {
                            continue;
                        }

                        let Some(expected_seq) = session.next_expected_seq else {
                            session.failed_attempts += 1;
                            if session.failed_attempts >= 16 {
                                // 連続でシーケンス番号が来ない場合は切断されたとみなしてセッションをクリーンアップする
                                session.ring_buffer = None;
                                session.next_expected_seq = None;
                                session.target_begin_time = None;
                                session.status = UserStatus::Disconnected;
                                session.failed_attempts = 0;
                            }
                            continue;
                        };
                        let expected_index = expected_seq as usize & RING_BUFFER_MASK;
                        let Some(ring_buffer) = &mut session.ring_buffer else {
                            continue;
                        };
                        let pcm_data = &ring_buffer[expected_index];
                        let mix_len = pcm_data.len().min(PCM_SAMPLES);
                        // PCMデータを合成波形に加算していく（オーバーフローに注意してi32で計算）
                        for i in 0..mix_len {
                            guild_sum[i] += pcm_data[i] as i32; // オーバーフローするために必要な人数>=65536は非現実的
                        }
                        // ring_bufferの該当スロットを空にする（次のパケットが来たときに上書きされる前に古いデータが残らないようにするため）
                        ring_buffer[expected_index].fill(0);
                        // 期待するシーケンス番号を更新
                        session.next_expected_seq = Some(expected_seq.wrapping_add(1));

                        // パケットを受信した時刻を更新
                        session.final_received_at = Instant::now();
                        // ユーザーの状態をActiveに更新
                        session.status = UserStatus::Active;
                    }

                    // ギルドの合成波形をユニオンの合成波形に加算していく
                    for i in 0..PCM_SAMPLES {
                        union_sum[i] += guild_sum[i];
                    }

                    // ギルドごとの合成波形を保存するマップに追加
                    guild_sums.insert(*guild_id, guild_sum);
                }

                // guild_sumsの中身のguild_sumをunion_sumからマイナスワンでクリップするループ（これにより、各ギルドの合成波形には自分以外のギルドの波形のみが入ることになる）
                for guild_sum in guild_sums.values_mut() {
                    for i in 0..PCM_SAMPLES {
                        // ギルドの合成波形からユニオン全体の合成波形を引いていく（マイナスワンでクリップ）
                        guild_sum[i] = union_sum[i].saturating_sub(guild_sum[i]);
                    }
                }

                // 送信するパケットのフォーマットは、受信したものからUser IDを抜いたものを使う
                let mut send_buf = Vec::with_capacity(SEND_HEADER_SIZE + PCM_SAMPLES * 2);
                send_buf.extend(&MAGIC_NUMBER.to_be_bytes());
                send_buf.push(VERSION);
                send_buf.push(TYPE_AUDIO);
                let mut union_id_bytes = [0u8; 16];
                let union_id_bytes_src = union_id.as_bytes();
                let copy_len = union_id_bytes_src.len().min(16);
                union_id_bytes[..copy_len].copy_from_slice(&union_id_bytes_src[..copy_len]);
                send_buf.extend(&union_id_bytes);

                // Union IDまでのヘッダーサイズ
                let common_header_len = 22;

                // シーケンス番号はUnion全体で共通のものを使う（ユーザーごとにシーケンス番号を管理するのは複雑になるため）
                let seq = outgoing_seq_map.entry(union_id.clone()).or_insert(0);

                let send_time = (SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or(Duration::ZERO)
                    .as_millis() as u64
                    % 65536) as u16;
                let send_time_bytes = send_time.to_be_bytes();
                let pcm_samples_bytes = ((union_sum.len() * 2) as u16).to_be_bytes();
                let empty_sum = [0i32; PCM_SAMPLES];

                // 合成波形をギルドごとに送信するループ
                let topo_read = topo_for_mix.read().await;

                for (guild_id, _guild_buffer) in union_buffer.iter() {
                    // 送信先のアドレスが不明な場合はスキップ
                    let Some(addr) = topo_read
                        .get(union_id)
                        .and_then(|guilds| {
                            guilds.iter().find(|(valid_g_id, _)| valid_g_id == guild_id)
                        })
                        .and_then(|(_, addr)| *addr)
                    else {
                        continue;
                    };

                    // ヘッダー部分までの長さに一旦切り詰めて再利用する
                    send_buf.truncate(common_header_len);

                    send_buf.extend_from_slice(&guild_id.to_be_bytes());
                    send_buf.extend_from_slice(&seq.to_be_bytes());
                    send_buf.extend_from_slice(&send_time_bytes);
                    send_buf.extend_from_slice(&pcm_samples_bytes);

                    // 4. 一時的なVecの排除とclamp関数の利用
                    let guild_sum = guild_sums.get(guild_id).unwrap_or(&empty_sum);
                    for &sample in guild_sum.iter() {
                        // clampを使うことでシンプルになり、コンパイラが最適化(SIMD等)しやすくなります
                        let clipped = sample.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                        send_buf.extend_from_slice(&clipped.to_le_bytes());
                    }

                    if let Err(e) = socket_for_mix.send_to(&send_buf, addr).await {
                        eprintln!("[Mixer] パケットの送信に失敗しました: {}", e);
                    }
                }

                // シーケンス番号を更新
                *seq = seq.wrapping_add(1);
            }

            // 切断されたユーザーのセッションをlocal_stateから完全に削除するループ
            for union_buffer in local_state.values_mut() {
                for guild_buffer in union_buffer.values_mut() {
                    guild_buffer.retain(|_user_id, session| {
                        !matches!(session.status, UserStatus::Disconnected)
                    });
                }
            }
        }
    });

    // メインスレッドを終了させないための待機
    tokio::signal::ctrl_c().await?;
    println!("Shutting down...");
    Ok(())
}

/// 受信した16bitのタイムスタンプ(Date.now() % 65536)から、
/// ローカルの単調増加クロック(Instant)を推定します。
pub fn estimate_packet_instant(ts_16: u16) -> Instant {
    // 現在のシステム時刻（Unixエポックからのミリ秒）を取得
    let sys_now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64;

    // 現在時刻の下位16ビットを抽出
    let now_16 = (sys_now_ms & 0xFFFF) as u16;

    // 16ビット同士の差分を計算し、i16にキャストして最短距離を求める
    // これにより、-32768 〜 32767ミリ秒の範囲の相対的なズレを自動算出します
    let diff_ms = ts_16.wrapping_sub(now_16) as i16;

    // 現在のInstantを取得
    let instant_now = Instant::now();

    // 差分をInstantに適用し、パケットが生成された(または生成される)と推定されるInstantを返す
    if diff_ms >= 0 {
        instant_now + Duration::from_millis(diff_ms as u64)
    } else {
        instant_now - Duration::from_millis(diff_ms.unsigned_abs() as u64)
    }
}

pub fn print_waveform(pcm: &[i16]) {
    // コンソールに表示する文字幅（適宜調整してください）
    let display_width = 80; 
    let chunk_size = pcm.len() / display_width;
    if chunk_size == 0 {
        return;
    }

    // 振幅の大きさを表現するブロック要素
    let chars = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let mut line = String::with_capacity(display_width);

    for chunk in pcm.chunks(chunk_size).take(display_width) {
        // 表示幅1文字分に相当するサンプル群の中から、最大の振幅（絶対値）を取得
        let max_amp = chunk.iter().map(|&s| s.unsigned_abs() as i32).max().unwrap_or(0);
        
        // 振幅を0~7のインデックスにマッピング
        // i16の最大値は32768ですが、通常の音声はそこまで振り切れないため
        // 少し感度を上げて16384あたりを最大表示としてクリップしています
        let index = (max_amp * 8 / 16384).clamp(0, 7) as usize;
        line.push(chars[index]);
    }

    println!("Wave: |{}|", line);
}
