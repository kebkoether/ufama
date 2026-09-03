#!/bin/bash
# Ufama v1.2 — Mainnet deployment (parallel set; cutover = Railway env flip)
#
# v1.2 over v1.1: atomic Router.execute_path multi-hop, Aqua pool
# auto-resolver, per-token SEP-40 feeds with PER-FEED max_age, two-step
# admin rotation, dust/expiry guards, min-side resolver ranking, and the
# 18-decimal-safe oracle cross-rate. Requires the fix/pre-deploy-hardening
# contract changes (PR #63) to be merged and built.
#
# Contracts must be built + optimized first:
#   cd contracts && cargo build --release --target wasm32v1-none
#   for w in fee_vault swap_book router twap_book aqua_adapter sushiswap_adapter; do
#     stellar contract optimize --wasm target/wasm32v1-none/release/$w.wasm
#   done
set -e
NETWORK="mainnet"
DEPLOYER="mainnet-deployer"
WASM="contracts/target/wasm32v1-none/release"

# ── External venue contracts (verified on-chain; see reference notes) ──
AQUA_ROUTER="CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK"
SUSHI_ROUTER="CDMIM23WOUL5CZBKX3GOA3V5R5AMVIMTCP52KCDQORWELAPLJ27WZCHL"
SUSHI_QUOTER="CASKWJSINHFW7BF7RUOA4E2FP6B2TYRKFX2UOPWLCPOOPUR6UU3G2RWC"
# LIVE factory only — Sushi's older CCRSMJDITH…GZGF deployment resolves
# stale pools and broke v1.1's unpinned pair resolution.
SUSHI_FACTORY="CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF"

# ── Oracles ──
# Reflector External Markets (14-dec, ~5-min pushes, free Pulse tier)
REFLECTOR="CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN"
# RedStone multi-feed adapter (8-dec, 0.01-0.2% deviation OR 12-24h
# heartbeat; assets keyed Asset::Stellar(<token contract>))
REDSTONE="CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF"
# Per-feed freshness bounds: Reflector pushes ~5 min (900s = 3 missed
# pushes); RedStone heartbeats up to 24h (90000s ≈ 25h). The global
# default only backstops feeds registered with max_age 0.
REFLECTOR_MAX_AGE=900
REDSTONE_MAX_AGE=90000
GLOBAL_MAX_AGE=900

# ── Token contracts (mainnet) ──
XLM_SAC="CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"
USDC_SAC="CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
EURC_SAC="CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV"
USDT0_SAC="CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF"
PYUSD_SAC="CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2"
USDY_SAC="CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP"
SOLVBTC="CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN"
XSOLVBTC="CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J"
DEJAAA="CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL"
DEJTRSY="CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV"

# Aqua XLM/USDC pool pin (highest-volume pool as of 2026-08-22)
AQUA_POOL_HASH="24f9c991c44acf33fff5f44031c40385d235dc212d7379e824ba3db1c35371f3"
AQUA_POOL_ADDR="CBBMQBNHB2FYVZYV7VNHOJHUMTFJLR4PUMRVQYNW6RHIKZO2NQMIBUCV"

ADMIN=$(stellar keys address ${DEPLOYER})
echo "admin: ${ADMIN}"

ERRLOG="${ERRLOG:-deploy-v12-errors.log}"
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
# FeeVault: REUSED from v1.1 (code unchanged, has set_admin, keeps all
# collected fees in one place). Override to deploy fresh.
FEE_VAULT="${FEE_VAULT:-CBNI2QR4LBM7GLLKSYOIASACBRSKNDMLDZAGUOTBBHMCAPCZH5HSHPXP}"
SWAPBOOK="${SWAPBOOK:-}"
ROUTER="${ROUTER:-}"
TWAPBOOK="${TWAPBOOK:-}"
AQUA_AD="${AQUA_AD:-}"
SUSHI_AD="${SUSHI_AD:-}"

[ -z "${FEE_VAULT}" ] && FEE_VAULT=$(dep ${WASM}/fee_vault.optimized.wasm --admin ${ADMIN}) || true
echo "FeeVault:  ${FEE_VAULT}"
[ -z "${SWAPBOOK}" ] && SWAPBOOK=$(dep ${WASM}/swap_book.optimized.wasm --admin ${ADMIN} --fee_vault ${FEE_VAULT}) || true
echo "SwapBook:  ${SWAPBOOK}"
[ -z "${ROUTER}" ] && ROUTER=$(dep ${WASM}/router.optimized.wasm --admin ${ADMIN} --fee_vault ${FEE_VAULT} --swap_book ${SWAPBOOK}) || true
echo "Router:    ${ROUTER}"
[ -z "${TWAPBOOK}" ] && TWAPBOOK=$(dep ${WASM}/twap_book.optimized.wasm --admin ${ADMIN} --fee_vault ${FEE_VAULT} --swap_book ${SWAPBOOK}) || true
echo "TwapBook:  ${TWAPBOOK}"
[ -z "${AQUA_AD}" ] && AQUA_AD=$(dep ${WASM}/aqua_adapter.optimized.wasm --admin ${ADMIN} --aqua_router ${AQUA_ROUTER}) || true
echo "AquaAdpt:  ${AQUA_AD}"
[ -z "${SUSHI_AD}" ] && SUSHI_AD=$(dep ${WASM}/sushiswap_adapter.optimized.wasm --admin ${ADMIN} --sushi_router ${SUSHI_ROUTER} --sushi_quoter ${SUSHI_QUOTER} --sushi_factory ${SUSHI_FACTORY}) || true
echo "SushiAdpt: ${SUSHI_AD}"

if [ -z "${SWAPBOOK}" ] || [ -z "${ROUTER}" ] || [ -z "${TWAPBOOK}" ] || [ -z "${AQUA_AD}" ] || [ -z "${SUSHI_AD}" ]; then
  echo "❌ contract deploy failed — check ${ERRLOG}; top up ${ADMIN} and rerun"
  exit 1
fi

echo ""
echo "wiring…"
inv ${SWAPBOOK} set_router --router ${ROUTER} && echo " ✓ SwapBook.set_router"
# Oracle admin: TEMPORARILY the deployer — repoint to the Railway oracle
# pusher's public key (set_oracle_admin) before oracle-mode orders open.
inv ${SWAPBOOK} set_oracle_admin --oracle_admin ${ADMIN} && echo " ✓ SwapBook.set_oracle_admin (temp: deployer)"
inv ${ROUTER} register_venue --venue_id 1 --contract_address ${AQUA_AD} && echo " ✓ Router venue 1 = Aqua"
inv ${ROUTER} register_venue --venue_id 2 --contract_address ${SUSHI_AD} && echo " ✓ Router venue 2 = Sushi"
inv ${TWAPBOOK} register_venue --venue_id 1 --contract_address ${AQUA_AD} && echo " ✓ TwapBook venue 1 = Aqua"
inv ${TWAPBOOK} register_venue --venue_id 2 --contract_address ${SUSHI_AD} && echo " ✓ TwapBook venue 2 = Sushi"

echo ""
echo "oracle feeds…"
inv ${SWAPBOOK} set_sep40_max_age --max_age_secs ${GLOBAL_MAX_AGE} && echo " ✓ global max_age ${GLOBAL_MAX_AGE}s"
# Reflector (Other-symbol keyed, ~5-min cadence)
reflector_feed() { # $1=token contract  $2=symbol  $3=label
  inv ${SWAPBOOK} set_sep40_feed --token "$1" --oracle ${REFLECTOR} \
    --asset "{\"Other\":\"$2\"}" --max_age_secs ${REFLECTOR_MAX_AGE} \
    && echo " ✓ feed $3 -> Reflector Other($2) @${REFLECTOR_MAX_AGE}s" \
    || echo " ✗ FAILED feed $3"
}
reflector_feed ${XLM_SAC}   XLM  XLM
reflector_feed ${USDC_SAC}  USDC USDC
reflector_feed ${EURC_SAC}  EURC EURC
# USDT0 is bridged Tether — Reflector's USDT is its fair-value feed
reflector_feed ${USDT0_SAC} USDT USDT0
# RedStone (Stellar-address keyed, deviation-push + 12-24h heartbeat —
# max_age must exceed the heartbeat or healthy feeds read as stale)
redstone_feed() { # $1=token contract  $2=label
  inv ${SWAPBOOK} set_sep40_feed --token "$1" --oracle ${REDSTONE} \
    --asset "{\"Stellar\":\"$1\"}" --max_age_secs ${REDSTONE_MAX_AGE} \
    && echo " ✓ feed $2 -> RedStone @${REDSTONE_MAX_AGE}s" \
    || echo " ✗ FAILED feed $2"
}
redstone_feed ${PYUSD_SAC} PYUSD
redstone_feed ${USDY_SAC}  USDY
redstone_feed ${SOLVBTC}   SolvBTC
redstone_feed ${XSOLVBTC}  xSolvBTC
redstone_feed ${DEJAAA}    deJAAA
redstone_feed ${DEJTRSY}   deJTRSY

echo ""
echo "pool pins…"
inv ${AQUA_AD} set_pool --token_a ${XLM_SAC} --token_b ${USDC_SAC} \
  --tokens "[\"${XLM_SAC}\",\"${USDC_SAC}\"]" \
  --pool_hash ${AQUA_POOL_HASH} --pool_address ${AQUA_POOL_ADDR} && echo " ✓ Aqua pool pinned (XLM/USDC)"

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
echo "ROUTER_V12=1"

echo ""
echo "── Post-deploy checklist (manual) ──"
echo "1. Pin remaining launch pools on the NEW adapters — the resolvers are"
echo "   hardened but pins are still the strongest guarantee:"
echo "     AQUA_AD=${AQUA_AD} bash scripts/register-aqua-pools.sh"
echo "     SUSHI_AD=${SUSHI_AD} bash scripts/register-sushi-pairs.sh"
echo "   (update those scripts' adapter IDs if they don't read the env)"
echo "2. Repoint oracle admin to the Railway pusher key:"
echo "     stellar contract invoke --id ${SWAPBOOK} --source ${DEPLOYER} --network mainnet -- \\"
echo "       set_oracle_admin --oracle_admin <ORACLE_SECRET_KEY pubkey>"
echo "3. Set dust floors once dust-testing is done (per-token, e.g. 0.01"
echo "   units of a 7-dec token = 100000):"
echo "     ... -- set_min_order --token ${USDC_SAC} --min_amount 100000"
echo "4. Rotate admin off the deployer when ready (two-step):"
echo "     ... -- transfer_admin --new_admin <NEW_ADMIN_G_ADDRESS>"
echo "     then from the new key: ... -- accept_admin"
echo "5. Flip the Railway envs above, press Deploy (env changes need it),"
echo "   then dust-test: instant XLM/USDC, multi-hop SolvBTC->PYUSD,"
echo "   P2P place/fill, TWAP, and an 18-dec pair quote (deJAAA/USDC)."
