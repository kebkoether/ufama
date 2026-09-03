#!/bin/bash
# Register Sushi pool pins on the v1.1 SushiSwap adapter.
#
# WHY THIS IS NEEDED: Sushi runs TWO factories on Stellar mainnet. The
# v1.1 adapter was deployed pointing at the older one
# (CCRSMJDITH3VK5QOGYCVZDAKIY5GL3RCG4TCVLIAVB662IW2V5KJGZGF), which does
# not know the RWA pools (deJAAA/USDC etc.) and resolves XLM/USDC to a
# STALE pool. The live factory — the one Sushi's own UI trades through —
# is CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF. Without a
# pin, adapter swaps fail with Error #6 (PairNotSet) or execute against
# the stale pool. Admin set_pair pins take precedence over the factory
# fallback, so this fixes execution WITHOUT a redeploy.
#
# Pool addresses below were verified two ways on 2026-08-25: Sushi's
# GraphQL pool list AND on-chain get_pool against the live factory.
# Idempotent (set_pair overwrites, registers both directions).
# Run: bash scripts/register-sushi-pairs.sh
set -e
# Default: the v1.2 Sushi adapter (deployed 2026-09-03, live factory).
# Override with ADAPTER=... for another deployment (v1.1 was CDFNVWKR…L3IY).
ADAPTER="${ADAPTER:-CAWVG65APH5K56AS7FWXKKDLSJQUO5WIGCVFUFFFRA2JOJ35OYERLCVR}"
SRC="mainnet-deployer"
NET="mainnet"
FEE=1000000
reg() {
  stellar contract invoke --fee ${FEE} --id ${ADAPTER} --source ${SRC} --network ${NET} -- set_pair \
    --token_a "$1" --token_b "$2" --fee "$3" --pool "$4" >/dev/null 2>&1 \
    && echo " ✓ $5" || echo " ✗ $5 (check funds/network)"
}

reg "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV" "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" 500  "CDMJRRH5MAJLB7T5SQAWQOOL7UJ3BABGTURSVKIE6AEDSXESDDJIBVCT" "deJTRSY / USDC (liq \$3.94M, fee 0.05%)"
reg "CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL" "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" 500  "CD7ZJUQEJODTJXWJMDJRV7UHCANOBX3FC6KXJV3DMIFX3JXUWMF3U3T5" "deJAAA / USDC (liq \$3.79M, fee 0.05%)"
reg "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA" "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" 3000 "CCR2CH4GQVCZHG7CHFVMNANCK45CU5DVKXZIIITDZQAU3CEJZ7RQH2MQ" "XLM / USDC (liq \$694k, fee 0.3%)"
reg "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2" "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" 500  "CC22BLZAFTS7M6Z25HOMKDLV65PBP5CIHFER2OTZB5IRNL3YBWDXKDFF" "PYUSD / USDC (liq \$669k, fee 0.05%)"
reg "CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP" "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" 500  "CA75VVHLWSM7W6ULNQI7ZJYDFOMQCCPKIDDDHBAL5KOKHWWKWQ5S7MHO" "USDY / USDC (liq \$615k, fee 0.05%)"

echo ""
echo "Done. v1.2 note: deploy the Sushi adapter with the LIVE factory"
echo "CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF so the"
echo "permissionless fallback works for future pools without pins."
