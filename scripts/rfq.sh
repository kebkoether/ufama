#!/bin/bash
# RFQ settlement contract — deploy / inspect.
#
#   bash scripts/rfq.sh deploy            # deploy rfq-settle, wired to FeeVault + SwapBook
#   bash scripts/rfq.sh status            # config / fee / fair-value readout
#   bash scripts/rfq.sh fair <IN> <OUT> <AMOUNT_IN>   # on-chain NAV for a pair (base units)
#
# Env: NET (mainnet|testnet, default mainnet), SRC (mainnet-deployer),
#      RFQ (contract id for status/fair; defaults to RFQ_CONTRACT_ID),
#      FEE_VAULT / SWAP_BOOK (default to the live set for NET).
set -euo pipefail

NET="${NET:-mainnet}"
FEE="${FEE:-1000000}"
if [ "$NET" = "mainnet" ]; then
  SRC="${SRC:-mainnet-deployer}"
  FEE_VAULT="${FEE_VAULT:-CBNI2QR4LBM7GLLKSYOIASACBRSKNDMLDZAGUOTBBHMCAPCZH5HSHPXP}"   # FeeVault (v1.1, reused)
  SWAP_BOOK="${SWAP_BOOK:-CB2KKROC2H6H757TY4H67ZAT3POFZWY532WOMQDQFWUFWK7PTJUTAEBN}"   # SwapBook v1.2
else
  SRC="${SRC:-deployer}"
  FEE_VAULT="${FEE_VAULT:-CAE7OFX4PJZ3YXP7WHSHGG6YGA2SOR6WBWCHCNRO4YIDXEYQYHMMAJPC}"
  SWAP_BOOK="${SWAP_BOOK:-CBHLP5NVC4MW5IW5LADGQHHH35LSDY2P6LM5RABKPGXVZVTYKGJJY3NI}"
fi
RFQ="${RFQ:-${RFQ_CONTRACT_ID:-}}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

view() { stellar contract invoke --id "$1" --network "$NET" --source "$SRC" --send=no -- "${@:2}" 2>/dev/null | tail -1; }
need_rfq() { [ -n "$RFQ" ] || { echo "set RFQ=<rfq contract id>"; exit 1; }; }

cmd="${1:-}"
case "$cmd" in
  deploy)
    cd "$HERE/contracts"
    echo "Building rfq-settle wasm…"
    cargo build --release --target wasm32v1-none -p rfq-settle >/dev/null
    WASM=target/wasm32v1-none/release/rfq_settle.wasm
    if stellar contract optimize --wasm "$WASM" >/dev/null 2>&1; then
      WASM=target/wasm32v1-none/release/rfq_settle.optimized.wasm
    fi
    ls -la "$WASM"
    ADMIN="$(stellar keys public-key "$SRC" 2>/dev/null || stellar keys address "$SRC")"
    echo "Deploying on $NET (admin=$ADMIN, fee_vault=$FEE_VAULT, swap_book=$SWAP_BOOK)…"
    RFQ="$(stellar contract deploy --fee "$FEE" --wasm "$WASM" --source "$SRC" --network "$NET" \
      -- --admin "$ADMIN" --fee_vault "$FEE_VAULT" --swap_book "$SWAP_BOOK" 2>/dev/null | tail -1)"
    echo "RFQ settlement contract: $RFQ"
    echo " get_config = $(view "$RFQ" get_config)"
    echo " get_fee    = $(view "$RFQ" get_fee)"
    echo ""
    echo "Railway env:"
    echo "  RFQ_CONTRACT_ID=$RFQ"
    echo "  RFQ_MAKER_KEYS=<label>:<key>,…   (then run a maker: npm run maker)"
    ;;

  status)
    need_rfq
    echo "RFQ $RFQ on $NET"
    echo " get_config = $(view "$RFQ" get_config)"
    echo " get_fee    = $(view "$RFQ" get_fee)"
    ;;

  fair)
    need_rfq
    IN="${2:?usage: rfq.sh fair <TOKEN_IN> <TOKEN_OUT> <AMOUNT_IN>}"
    OUT="${3:?}"
    AMT="${4:?}"
    echo " fair_value($IN → $OUT, $AMT) = $(view "$RFQ" fair_value --token_in "$IN" --token_out "$OUT" --amount_in "$AMT")"
    ;;

  *)
    echo "usage: rfq.sh deploy | status | fair <IN> <OUT> <AMOUNT_IN>"
    exit 1
    ;;
esac
