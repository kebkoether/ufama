#!/bin/bash
# Ufama v1.1 — Mainnet deployment (parallel set; cutover = Railway env flip)
# Contracts must be built + optimized first:
#   cd contracts && cargo build --release --target wasm32v1-none
#   stellar contract optimize --wasm target/wasm32v1-none/release/<each>.wasm
set -e
NETWORK="mainnet"
DEPLOYER="mainnet-deployer"
WASM="contracts/target/wasm32v1-none/release"

# External venue contracts (verified on-chain; see reference notes)
AQUA_ROUTER="CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK"
SUSHI_ROUTER="CDMIM23WOUL5CZBKX3GOA3V5R5AMVIMTCP52KCDQORWELAPLJ27WZCHL"
SUSHI_QUOTER="CASKWJSINHFW7BF7RUOA4E2FP6B2TYRKFX2UOPWLCPOOPUR6UU3G2RWC"
SUSHI_FACTORY="CCRSMJDITH3VK5QOGYCVZDAKIY5GL3RCG4TCVLIAVB662IW2V5KJGZGF"

# Aqua XLM/USDC pool registration (highest-volume pool as of 2026-08-22)
XLM_SAC="CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"
USDC_SAC="CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
AQUA_POOL_HASH="24f9c991c44acf33fff5f44031c40385d235dc212d7379e824ba3db1c35371f3"
AQUA_POOL_ADDR="CBBMQBNHB2FYVZYV7VNHOJHUMTFJLR4PUMRVQYNW6RHIKZO2NQMIBUCV"

ADMIN=$(stellar keys address ${DEPLOYER})
echo "admin: ${ADMIN}"

ERRLOG="${ERRLOG:-deploy-v11-errors.log}"
# --fee is the max INCLUSION fee bid in stroops (0.1 XLM); mainnet surge
# pricing rejects the 100-stroop default with TxInsufficientFee. Unused
# margin is not charged. Retry each step twice for transient DNS blips.
FEE=1000000
dep() {
  for attempt in 1 2 3; do
    OUT=$(stellar contract deploy --fee ${FEE} --wasm "$1" --source ${DEPLOYER} --network ${NETWORK} -- "${@:2}" 2>>"${ERRLOG}" | tail -1)
    [ -n "${OUT}" ] && { echo "${OUT}"; return; }
    sleep 3
  done
  echo ""
}
inv() {
  for attempt in 1 2 3; do
    stellar contract invoke --fee ${FEE} --id "$1" --source ${DEPLOYER} --network ${NETWORK} -- "${@:2}" >/dev/null 2>>"${ERRLOG}" && return 0
    sleep 3
  done
  return 1
}

# RESUMABLE: contracts deployed by earlier runs are pinned here so a rerun
# never duplicates them. Blank = deploy on this run.
FEE_VAULT="${FEE_VAULT:-CBNI2QR4LBM7GLLKSYOIASACBRSKNDMLDZAGUOTBBHMCAPCZH5HSHPXP}"
AQUA_AD="${AQUA_AD:-CCTL6C4PYDTXT6GL5YTE6CG4ZH2EXKJONUP4445SMTY5AYQPNQY666HZ}"
SUSHI_AD="${SUSHI_AD:-CDFNVWKR6BO57LR3PMGGDK456FOAOILKSPE56GYRFGIY2Q5JPUULL3IY}"

[ -z "${FEE_VAULT}" ] && FEE_VAULT=$(dep ${WASM}/fee_vault.optimized.wasm --admin ${ADMIN}) || true
echo "FeeVault:  ${FEE_VAULT}"
SWAPBOOK="${SWAPBOOK:-$(dep ${WASM}/swap_book.optimized.wasm --admin ${ADMIN} --fee_vault ${FEE_VAULT})}"
echo "SwapBook:  ${SWAPBOOK}"
ROUTER="${ROUTER:-$(dep ${WASM}/router.optimized.wasm --admin ${ADMIN} --fee_vault ${FEE_VAULT} --swap_book ${SWAPBOOK})}"
echo "Router:    ${ROUTER}"
TWAPBOOK="${TWAPBOOK:-$(dep ${WASM}/twap_book.optimized.wasm --admin ${ADMIN} --fee_vault ${FEE_VAULT} --swap_book ${SWAPBOOK})}"
echo "TwapBook:  ${TWAPBOOK}"
[ -z "${AQUA_AD}" ] && AQUA_AD=$(dep ${WASM}/aqua_adapter.optimized.wasm --admin ${ADMIN} --aqua_router ${AQUA_ROUTER}) || true
echo "AquaAdpt:  ${AQUA_AD}"
[ -z "${SUSHI_AD}" ] && SUSHI_AD=$(dep ${WASM}/sushiswap_adapter.optimized.wasm --admin ${ADMIN} --sushi_router ${SUSHI_ROUTER} --sushi_quoter ${SUSHI_QUOTER} --sushi_factory ${SUSHI_FACTORY}) || true
echo "SushiAdpt: ${SUSHI_AD}"

if [ -z "${SWAPBOOK}" ] || [ -z "${ROUTER}" ] || [ -z "${TWAPBOOK}" ]; then
  echo "❌ core contract deploy failed — check ${ERRLOG}; top up ${ADMIN} and rerun"
  exit 1
fi

echo "wiring…"
inv ${SWAPBOOK} set_router --router ${ROUTER} && echo " ✓ SwapBook.set_router"
# Oracle admin: TEMPORARILY the deployer — repoint to the Railway oracle
# pusher's public key (set_oracle_admin) before oracle-mode orders open.
inv ${SWAPBOOK} set_oracle_admin --oracle_admin ${ADMIN} && echo " ✓ SwapBook.set_oracle_admin (temp: deployer)"
inv ${ROUTER} register_venue --venue_id 1 --contract_address ${AQUA_AD} && echo " ✓ Router venue 1 = Aqua"
inv ${ROUTER} register_venue --venue_id 2 --contract_address ${SUSHI_AD} && echo " ✓ Router venue 2 = Sushi"
inv ${TWAPBOOK} register_venue --venue_id 1 --contract_address ${AQUA_AD} && echo " ✓ TwapBook venue 1 = Aqua"
inv ${TWAPBOOK} register_venue --venue_id 2 --contract_address ${SUSHI_AD} && echo " ✓ TwapBook venue 2 = Sushi"
inv ${AQUA_AD} set_pool --token_a ${XLM_SAC} --token_b ${USDC_SAC} \
  --tokens "[\"${XLM_SAC}\",\"${USDC_SAC}\"]" \
  --pool_hash ${AQUA_POOL_HASH} --pool_address ${AQUA_POOL_ADDR} && echo " ✓ Aqua pool registered (XLM/USDC)"

echo ""
echo "verify fees:"
stellar contract invoke --id ${ROUTER}   --source ${DEPLOYER} --network ${NETWORK} -- get_fee 2>/dev/null | tail -1
stellar contract invoke --id ${SWAPBOOK} --source ${DEPLOYER} --network ${NETWORK} -- get_fee 2>/dev/null | tail -1
stellar contract invoke --id ${TWAPBOOK} --source ${DEPLOYER} --network ${NETWORK} -- get_fee 2>/dev/null | tail -1

echo ""
echo "── Railway env cutover ──"
echo "SWAPBOOK_CONTRACT_ID=${SWAPBOOK}"
echo "ROUTER_CONTRACT_ID=${ROUTER}"
echo "FEE_VAULT_CONTRACT_ID=${FEE_VAULT}"
echo "TWAP_BOOK_CONTRACT_ID=${TWAPBOOK}"
echo "AQUA_ADAPTER_CONTRACT_ID=${AQUA_AD}"
echo "SUSHI_ADAPTER_CONTRACT_ID=${SUSHI_AD}"
echo "SWAPBOOK_V11=1"
