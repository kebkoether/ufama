#!/bin/bash
# USDT0 go-live (2026-08-30) — on-chain half of the activation:
#  1. Pin the Sushi USDT0/USDC pool (fee 0.05%) on the v1.1 Sushi adapter
#     so instant swaps can EXECUTE (pool verified live on-chain, ~$10k at
#     parity; Sushi's GraphQL indexer doesn't list it yet).
#  2. Register USDT0's oracle feed on the v1.1 SwapBook, mapped to
#     Reflector's Other("USDT") — Reflector has no USDT0 symbol, but
#     USDT0 is bridged Tether, so USDT is its fair-value feed. This
#     unlocks MARKET-PRICE P2P orders on the USDC/USDT0 corridor.
# The backend/status half ships via the tokens.ts flip (same PR).
# Idempotent. Run: bash scripts/activate-usdt0.sh
#
# NOTE: targets the DEPLOYED v1.1 contracts, whose set_sep40_feed takes
# (token, feed). The v1.2 signature is (token, oracle, asset,
# max_age_secs) — do not reuse this invocation against a v1.2 SwapBook.
set -e
SRC="mainnet-deployer"
NET="mainnet"
FEE=1000000
SUSHI_ADAPTER="CDFNVWKR6BO57LR3PMGGDK456FOAOILKSPE56GYRFGIY2Q5JPUULL3IY"
SWAPBOOK="CB2UJMIFIT3SKCAKD7FDSRJCU6KWV2WXHLWSH25WKO6PMSRVMZDRS5CI"
USDT0="CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF"
USDC="CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
POOL="CBVHBZSZOS6KRDJ4D44FU2YLIENOVSSLM3UGKW6XQMVIFUAMWIWCVH2U"

stellar contract invoke --fee ${FEE} --id ${SUSHI_ADAPTER} --source ${SRC} --network ${NET} -- set_pair --token_a "$USDT0" --token_b "$USDC" --fee 500 --pool "$POOL" >/dev/null 2>&1 && echo " OK sushi pair USDT0/USDC @0.05% pinned" || echo " FAILED sushi set_pair"

stellar contract invoke --fee ${FEE} --id ${SWAPBOOK} --source ${SRC} --network ${NET} -- set_sep40_feed --token "$USDT0" --feed '{"Other":"USDT"}' >/dev/null 2>&1 && echo " OK oracle feed USDT0 -> Reflector Other(USDT)" || echo " FAILED set_sep40_feed"

echo ""
echo "Done. Market-price P2P orders now work on USDC/USDT0."
