#!/bin/bash
# Ufama Router v1.2.1 — positive-slippage share redeploy.
#
# The Router is intentionally non-upgradeable, so the surplus-share
# feature (execute_route / execute_path gain a trailing estimated_out
# arg; the protocol keeps get_surplus_share of any output above it)
# ships as a NEW Router contract. The Router is stateless apart from
# its venue registry and fee settings, so the cutover is small:
#   1. deploy the new Router (same FeeVault + SwapBook)
#   2. register the v1.2 venue adapters on it
#   3. repoint SwapBook.set_router (timer-claim escrow destination)
#   4. flip ROUTER_CONTRACT_ID + ROUTER_SURPLUS=1 on Railway
# The old Router keeps working for in-flight builds during the flip —
# it just stops being referenced.
#
# Build first:
#   cd contracts && cargo build --release --target wasm32v1-none
#   stellar contract optimize --wasm target/wasm32v1-none/release/router.wasm
set -e
NETWORK="mainnet"
DEPLOYER="mainnet-deployer"
WASM="contracts/target/wasm32v1-none/release/router.optimized.wasm"

# v1.2 set (deployed 2026-09-03)
FEE_VAULT="CBNI2QR4LBM7GLLKSYOIASACBRSKNDMLDZAGUOTBBHMCAPCZH5HSHPXP"
SWAPBOOK="CB2KKROC2H6H757TY4H67ZAT3POFZWY532WOMQDQFWUFWK7PTJUTAEBN"
AQUA_AD="CBYQV73IOS3KFIXZV6TC3LC7CPQQGTFQG2UEJ5EF5LFBMVBF7XRSUJCE"
SUSHI_AD="CAWVG65APH5K56AS7FWXKKDLSJQUO5WIGCVFUFFFRA2JOJ35OYERLCVR"

# Protocol's share of positive slippage, bps (contract default 2500 =
# 25%, hard cap 5000). Override: SURPLUS_SHARE_BPS=1000 bash scripts/...
SURPLUS_SHARE_BPS="${SURPLUS_SHARE_BPS:-2500}"

ADMIN=$(stellar keys address ${DEPLOYER})
echo "admin: ${ADMIN}"

ERRLOG="${ERRLOG:-deploy-router-v121-errors.log}"
FEE=1000000
inv() {
  for attempt in 1 2 3; do
    stellar contract invoke --fee ${FEE} --id "$1" --source ${DEPLOYER} --network ${NETWORK} -- "${@:2}" >/dev/null 2>>"${ERRLOG}" && return 0
    sleep 3
  done
  return 1
}

ROUTER="${ROUTER:-}"
if [ -z "${ROUTER}" ]; then
  for attempt in 1 2 3; do
    ROUTER=$(stellar contract deploy --fee ${FEE} --wasm "${WASM}" --source ${DEPLOYER} --network ${NETWORK} -- \
      --admin ${ADMIN} --fee_vault ${FEE_VAULT} --swap_book ${SWAPBOOK} 2>>"${ERRLOG}" | tail -1)
    [ -n "${ROUTER}" ] && break
    sleep 3
  done
fi
if [ -z "${ROUTER}" ]; then
  echo "❌ router deploy failed — check ${ERRLOG}; top up ${ADMIN} and rerun"
  exit 1
fi
echo "Router v1.2.1: ${ROUTER}"

echo "wiring…"
inv ${ROUTER} register_venue --venue_id 1 --contract_address ${AQUA_AD} && echo " ✓ venue 1 = Aqua"
inv ${ROUTER} register_venue --venue_id 2 --contract_address ${SUSHI_AD} && echo " ✓ venue 2 = Sushi"
inv ${SWAPBOOK} set_router --router ${ROUTER} && echo " ✓ SwapBook.set_router → v1.2.1"
if [ "${SURPLUS_SHARE_BPS}" != "2500" ]; then
  inv ${ROUTER} set_surplus_share --share_bps ${SURPLUS_SHARE_BPS} && echo " ✓ surplus share ${SURPLUS_SHARE_BPS} bps"
else
  echo " ✓ surplus share: contract default 2500 bps (25%)"
fi

echo ""
echo "verify:"
stellar contract invoke --id ${ROUTER} --source ${DEPLOYER} --network ${NETWORK} -- get_fee 2>/dev/null | tail -1
stellar contract invoke --id ${ROUTER} --source ${DEPLOYER} --network ${NETWORK} -- get_surplus_share 2>/dev/null | tail -1

echo ""
echo "── Railway env cutover (then press Deploy) ──"
echo "ROUTER_CONTRACT_ID=${ROUTER}"
echo "ROUTER_SURPLUS=1"
echo "SURPLUS_SHARE_BPS=${SURPLUS_SHARE_BPS}"
echo ""
echo "Note: builds created against the OLD router in the seconds around"
echo "the flip still execute there (it stays wired to the venues); only"
echo "new builds carry the estimated_out arg."
