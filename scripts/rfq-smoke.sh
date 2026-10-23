#!/bin/bash
# RFQ smoke test against a running backend: open a request as a CLI
# identity, wait for a maker, accept the best quote, sign with the CLI,
# submit through the backend relay, report balances before/after.
#
#   API=https://atomicswap-aggregator-production.up.railway.app NET=mainnet TAKER=mainnet-tester \
#     TOKEN_IN=XLM TOKEN_OUT=USDC AMOUNT=10000000 bash scripts/rfq-smoke.sh
#
# TOKEN_IN/TOKEN_OUT: symbols the backend resolves (or SAC addresses).
# AMOUNT in base units of TOKEN_IN. DRY=1 stops before signing.
set -euo pipefail
API="${API:-http://localhost:3001}"
NET="${NET:-testnet}"
TAKER_ID="${TAKER:-taker}"
TOKEN_IN="${TOKEN_IN:-USDC}"
TOKEN_OUT="${TOKEN_OUT:-USDT0}"
AMOUNT="${AMOUNT:-10000000}"
TTL="${TTL:-20}"
HORIZON="https://horizon.stellar.org"; [ "$NET" = testnet ] && HORIZON="https://horizon-testnet.stellar.org"
TAKER="$(stellar keys public-key "$TAKER_ID")"

j() { python -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
bal() { curl -s "$HORIZON/accounts/$TAKER" | j "[(b.get('asset_code','XLM'), b['balance']) for b in d['balances']]"; }

echo "taker $TAKER ($TAKER_ID) on $NET via $API"
echo "balances before: $(bal)"
REQ="$(curl -s -X POST "$API/api/rfq/request" -H 'Content-Type: application/json' \
  -d "{\"taker\":\"$TAKER\",\"tokenIn\":\"$TOKEN_IN\",\"tokenOut\":\"$TOKEN_OUT\",\"amountIn\":\"$AMOUNT\",\"ttlSec\":$TTL}")"
ID="$(echo "$REQ" | j "d.get('request',{}).get('id') or ('ERROR: '+str(d.get('error')))")"
case "$ID" in ERROR*) echo "$ID"; exit 1;; esac
echo "request $ID"
echo "reference: $(echo "$REQ" | j "d['request']['reference']")"

for i in $(seq 1 15); do
  sleep 2
  R="$(curl -s "$API/api/rfq/$ID")"
  N="$(echo "$R" | j "len([q for q in d['request']['quotes'] if q['status']=='live'])")"
  echo " t+$((i*2))s live quotes: $N"
  [ "$N" -gt 0 ] && break
done
[ "${N:-0}" -gt 0 ] || { echo "no quotes arrived — is a maker connected? ($(curl -s "$API/api/health" | j "d.get('rfq')"))"; exit 2; }
echo "$R" | j "[(q['makerLabel'], q['amountOut'], 'vsNav', q['vsNavBps'], 'band', q['maxNavDevBps']) for q in d['request']['quotes']]"
QID="$(echo "$R" | j "sorted([q for q in d['request']['quotes'] if q['status']=='live'], key=lambda q: -int(q['amountOut']))[0]['id']")"
[ "${DRY:-0}" = 1 ] && { echo "DRY=1: stopping before accept"; exit 0; }

ACC="$(curl -s -X POST "$API/api/rfq/$ID/accept" -H 'Content-Type: application/json' -d "{\"quoteId\":\"$QID\"}")"
XDR="$(echo "$ACC" | j "d.get('xdr') or ('ERROR: '+str(d.get('error')))")"
case "$XDR" in ERROR*) echo "$XDR"; exit 1;; esac
SIGNED="$(echo "$XDR" | stellar tx sign --sign-with-key "$TAKER_ID" --network "$NET" 2>/dev/null)"
SUB="$(curl -s -X POST "$API/api/swap/submit" -H 'Content-Type: application/json' -d "{\"signedXdr\":\"$SIGNED\"}")"
HASH="$(echo "$SUB" | j "d.get('hash') or ('ERROR: '+str(d.get('error')))")"
case "$HASH" in ERROR*) echo "$HASH"; exit 1;; esac
curl -s -X POST "$API/api/rfq/$ID/settled" -H 'Content-Type: application/json' -d "{\"hash\":\"$HASH\"}" >/dev/null
echo "settled $HASH"
[ "$NET" = mainnet ] && echo "https://stellar.expert/explorer/public/tx/$HASH" || echo "https://stellar.expert/explorer/testnet/tx/$HASH"
sleep 3
echo "balances after:  $(bal)"
