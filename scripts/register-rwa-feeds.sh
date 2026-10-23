#!/bin/bash
# Register RedStone SEP-40 feeds on the mainnet SwapBook for the Etherfuse
# stablebonds, so USDC<->USTRY/CETES/TESOURO get an on-chain NAV: the RFQ
# band enforces it and standing orders can be oracle-pegged.
#
# RedStone publishes all three (checked 2026-10-23: USTRY 1.0779, CETES
# 0.0636, TESOURO 0.2557 USD, 8 dec, ~10h-old heartbeat readings — hence
# max_age 90000s, same as the other RedStone feeds registered in
# deploy-mainnet-v12.sh). Admin = mainnet-deployer (SwapBook admin).
#
#   bash scripts/register-rwa-feeds.sh
set -euo pipefail
NET="${NET:-mainnet}"
SRC="${SRC:-mainnet-deployer}"
SB="${SWAPBOOK:-CB2KKROC2H6H757TY4H67ZAT3POFZWY532WOMQDQFWUFWK7PTJUTAEBN}"
RS="${REDSTONE:-CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF}"
RFQ="${RFQ:-CBFNGCV7IIZC2E2LUQFLBJU2E4UKG4AINSDWWOU5S64OFKHXTOB74DNB}"
USDC=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75
MAX_AGE="${MAX_AGE:-90000}"

for pair in \
  USTRY:CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR \
  CETES:CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV \
  TESOURO:CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS; do
  sym=${pair%%:*}; sac=${pair##*:}
  echo "== $sym"
  stellar contract invoke --fee 1000000 --id "$SB" --network "$NET" --source "$SRC" -- \
    set_sep40_feed --token "$sac" --oracle "$RS" --asset "{\"Stellar\":\"$sac\"}" --max_age_secs "$MAX_AGE" >/dev/null \
    && echo " ✓ feed $sym -> RedStone @${MAX_AGE}s" || { echo " ✗ set_sep40_feed failed for $sym"; exit 1; }
  echo " fair_value(1000 USDC -> $sym) = $(stellar contract invoke --id "$RFQ" --network "$NET" --source "$SRC" --send=no -- fair_value --token_in "$USDC" --token_out "$sac" --amount_in 10000000000 2>/dev/null | tail -1)"
done
echo "Done. RFQ quotes on these pairs now default to a 50 bps on-chain NAV band."
