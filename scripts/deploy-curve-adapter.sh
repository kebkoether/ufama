#!/bin/bash
# Deploy the Curve (StableSwap-NG) adapter and register it as venue 4 on
# the ufama Router. Idempotent-ish: re-running deploys a NEW adapter and
# re-points the venue (register_venue fails if the id exists — run
# remove_venue first, or set VENUE_ID differently).
#
# Usage:
#   NET=testnet bash scripts/deploy-curve-adapter.sh            # testnet defaults below
#   NET=mainnet SRC=mainnet-deployer FACTORY=C... ROUTER=C... bash scripts/deploy-curve-adapter.sh
#
# Testnet defaults (2026-10-15): Curve factory CANV76QK…MHDS, ufama Router
# CDHWQFVZ…35LR (deployer = testnet admin).
set -euo pipefail

NET="${NET:-testnet}"
SRC="${SRC:-deployer}"
VENUE_ID="${VENUE_ID:-4}"
if [ "$NET" = "testnet" ]; then
  FACTORY="${FACTORY:-CANV76QKMKSQ26WZMLGVBGML5BCXKKZN2D2Q7HWFLKAEYZ6WWOJ6MHDS}"
  ROUTER="${ROUTER:-CDHWQFVZ7CIUZQL334ZQW2IEINCM3H66SZD77WO2IQ2NBUTKO2UF35LR}"
else
  : "${FACTORY:?set FACTORY to the mainnet Curve factory address}"
  : "${ROUTER:?set ROUTER to the mainnet ufama Router address}"
fi
FEE="${FEE:-1000000}"

cd "$(dirname "$0")/../contracts"
echo "Building curve-adapter wasm…"
cargo build --release --target wasm32v1-none -p curve-adapter >/dev/null
WASM=target/wasm32v1-none/release/curve_adapter.wasm
if command -v stellar >/dev/null && stellar contract optimize --help >/dev/null 2>&1; then
  stellar contract optimize --wasm "$WASM" >/dev/null 2>&1 && WASM=target/wasm32v1-none/release/curve_adapter.optimized.wasm || true
fi
ls -la "$WASM"

ADMIN="$(stellar keys public-key "$SRC" 2>/dev/null || stellar keys address "$SRC")"
echo "Deploying (admin=$ADMIN factory=$FACTORY network=$NET)…"
ADAPTER="$(stellar contract deploy --fee "$FEE" --wasm "$WASM" --source "$SRC" --network "$NET" \
  -- --admin "$ADMIN" --factory "$FACTORY" 2>/dev/null | tail -1)"
echo "Curve adapter: $ADAPTER"

echo "Registering venue $VENUE_ID on Router $ROUTER…"
stellar contract invoke --fee "$FEE" --id "$ROUTER" --source "$SRC" --network "$NET" -- register_venue \
  --venue_id "$VENUE_ID" --contract_address "$ADAPTER" >/dev/null
echo " ✓ registered"

echo ""
echo "Backend env:"
echo "  CURVE_ADAPTER_CONTRACT_ID=$ADAPTER"
echo "  CURVE_FACTORY_CONTRACT_ID=$FACTORY"
