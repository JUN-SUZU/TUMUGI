redis-cli flushall
screen -dmSU jet nats-server -js
cd mixer
cargo build
screen -dmSU mixer cargo run
cd ..
screen -dmSU orchestrator node orchestrator.js
screen -dmSU tumm node index.js
