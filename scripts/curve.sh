#!/bin/bash
# Curve (StableSwap-NG) venue — mainnet launch tooling.
#
# The adapter deploys UNARMED (no factory) and sits registered as venue 4
# on the Router doing nothing. Launch day = `arm <factory>`: one admin
# call. The backend reads the adapter's get_factory on its discovery
# cadence (10 min) and starts quoting every pool the factory lists — no
# Railway change, no Deploy press.
#
#   bash scripts/curve.sh deploy                 # today: deploy unarmed + register venue 4
#   bash scripts/curve.sh preflight <FACTORY>    # launch day: verify Curve's mainnet ABI matches
#   bash scripts/curve.sh arm <FACTORY>          # launch day: set_factory (after preflight passes)
#   bash scripts/curve.sh status                 # any time: adapter/factory/venue readout
#   bash scripts/curve.sh derive <ADMIN_G...>    # pre-launch: the factory address Curve's deploy.sh
#                                                #   will produce for that admin (deterministic salt)
#
# Reviewed against curvefi/stableswap-rs release/v1.0.0 (2026-10-23): the
# ABI this adapter targets is exactly what that release ships — see the
# "Curve v1.0.0 review" note in DEPLOYMENTS.md. Optional pins for
# preflight: EXPECTED_POOL_WASM_SHA256 / EXPECTED_FACTORY_WASM_SHA256
# (from the release's SHA256SUMS) make preflight refuse a pool or factory
# that is not running the audited release build.
#
# Env: NET (mainnet), SRC (mainnet-deployer), ROUTER (mainnet Router),
#      ADAPTER (for preflight/arm/status; defaults to CURVE_ADAPTER env).
set -euo pipefail

NET="${NET:-mainnet}"
SRC="${SRC:-mainnet-deployer}"
VENUE_ID="${VENUE_ID:-4}"
FEE="${FEE:-1000000}"
if [ "$NET" = "mainnet" ]; then
  ROUTER="${ROUTER:-CCT3IA6HKUA5GCAR7XLSNR4N5V2WEKDM6G4OSZ4EDXNS56CLDFBT2BDO}"   # Router v1.2.1
else
  ROUTER="${ROUTER:-CDHWQFVZ7CIUZQL334ZQW2IEINCM3H66SZD77WO2IQ2NBUTKO2UF35LR}"   # testnet Router
fi
ADAPTER="${ADAPTER:-${CURVE_ADAPTER:-}}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

inv() { stellar contract invoke --fee "$FEE" --id "$1" --source "$SRC" --network "$NET" "${@:2}"; }
view() { stellar contract invoke --id "$1" --network "$NET" --source "$SRC" --send=no -- "${@:2}" 2>/dev/null | tail -1; }
need_adapter() { [ -n "$ADAPTER" ] || { echo "set ADAPTER=<curve adapter contract id>"; exit 1; }; }

cmd="${1:-}"
case "$cmd" in
  deploy)
    cd "$HERE/contracts"
    echo "Building curve-adapter wasm…"
    cargo build --release --target wasm32v1-none -p curve-adapter >/dev/null
    WASM=target/wasm32v1-none/release/curve_adapter.wasm
    if stellar contract optimize --wasm "$WASM" >/dev/null 2>&1; then
      WASM=target/wasm32v1-none/release/curve_adapter.optimized.wasm
    fi
    ls -la "$WASM"
    ADMIN="$(stellar keys public-key "$SRC" 2>/dev/null || stellar keys address "$SRC")"
    echo "Deploying UNARMED (admin=$ADMIN, no factory) on $NET…"
    ADAPTER="$(stellar contract deploy --fee "$FEE" --wasm "$WASM" --source "$SRC" --network "$NET" \
      -- --admin "$ADMIN" 2>/dev/null | tail -1)"
    echo "Curve adapter: $ADAPTER"
    echo "Registering venue $VENUE_ID on Router $ROUTER…"
    inv "$ROUTER" -- register_venue --venue_id "$VENUE_ID" --contract_address "$ADAPTER" >/dev/null
    echo " ✓ registered"
    echo ""
    echo "Railway env (set now; the venue stays dormant until armed):"
    echo "  CURVE_ADAPTER_CONTRACT_ID=$ADAPTER"
    echo "Then: bash scripts/curve.sh preflight <FACTORY> && bash scripts/curve.sh arm <FACTORY>"
    ;;

  preflight)
    FACTORY="${2:?usage: curve.sh preflight <FACTORY>}"
    echo "Checking Curve factory $FACTORY on $NET against the ABI this adapter was built for…"
    FI="$(stellar contract info interface --id "$FACTORY" --network "$NET" 2>/dev/null)"
    ok=1
    for f in "fn pool_count" "fn pool_registration"; do
      echo "$FI" | grep -q "$f" && echo " ✓ factory: $f" || { echo " ✗ factory: $f MISSING"; ok=0; }
    done
    COUNT="$(view "$FACTORY" pool_count)"
    echo " pool_count = $COUNT"
    if [ "${COUNT:-0}" -gt 0 ] 2>/dev/null; then
      REG="$(view "$FACTORY" pool_registration --pool_index 0)"
      POOL="$(echo "$REG" | sed -n 's/.*"pool":"\([A-Z0-9]*\)".*/\1/p')"
      echo " pool[0] = $POOL"
      echo "$REG" | grep -q '"coins"' && echo " ✓ registration carries coins[]" || { echo " ✗ registration has no coins[]"; ok=0; }
      PI="$(stellar contract info interface --id "$POOL" --network "$NET" 2>/dev/null)"
      # Provenance: the pool must name THIS factory (release/v1.0.0 `factory()`).
      PF="$(view "$POOL" factory | tr -d '"')"
      [ "$PF" = "$FACTORY" ] && echo " ✓ pool.factory() == $FACTORY" || { echo " ✗ pool.factory() = $PF (expected $FACTORY)"; ok=0; }
      # Optional: pin the on-chain wasm to the release build's SHA256SUMS.
      if [ -n "${EXPECTED_POOL_WASM_SHA256:-}" ]; then
        PH="$(stellar contract fetch --id "$POOL" --network "$NET" 2>/dev/null | sha256sum | cut -d' ' -f1)"
        [ "$PH" = "$EXPECTED_POOL_WASM_SHA256" ] && echo " ✓ pool wasm sha256 matches release" || { echo " ✗ pool wasm sha256 $PH != expected"; ok=0; }
      fi
      if [ -n "${EXPECTED_FACTORY_WASM_SHA256:-}" ]; then
        FH="$(stellar contract fetch --id "$FACTORY" --network "$NET" 2>/dev/null | sha256sum | cut -d' ' -f1)"
        [ "$FH" = "$EXPECTED_FACTORY_WASM_SHA256" ] && echo " ✓ factory wasm sha256 matches release" || { echo " ✗ factory wasm sha256 $FH != expected"; ok=0; }
      fi
      echo "$PI" | grep -q "fn get_dy" && echo " ✓ pool: get_dy" || { echo " ✗ pool: get_dy MISSING"; ok=0; }
      echo "$PI" | grep -q "fn get_balances" && echo " ✓ pool: get_balances" || { echo " ✗ pool: get_balances MISSING"; ok=0; }
      # exchange(caller, i, j, dx, min_dy, receiver) — argument ORDER matters
      echo "$PI" | tr -d '\n ' | grep -q "fnexchange(env:soroban_sdk::Env,caller:soroban_sdk::Address,i:u32,j:u32,dx:i128,min_dy:i128,receiver:soroban_sdk::MuxedAddress,)" \
        && echo " ✓ pool: exchange(caller,i,j,dx,min_dy,receiver)" \
        || { echo " ✗ pool: exchange signature differs — DO NOT ARM, adapter needs a rebuild"; ok=0; }
      # Funds-pull mechanism: simulate from the deployer; the diagnostics
      # must show a nested transfer(caller → pool) — what the adapter
      # pre-authorizes. A transfer_from/allowance pull would need a change.
      ME="$(stellar keys public-key "$SRC" 2>/dev/null || stellar keys address "$SRC")"
      SIM="$(stellar contract invoke --id "$POOL" --network "$NET" --source "$SRC" --send=no -- exchange --caller "$ME" --i 0 --j 1 --dx 1 --min_dy 0 --receiver "$ME" 2>&1 || true)"
      if echo "$SIM" | grep -q "fn_call.*, transfer\]"; then
        echo " ✓ pool pulls input via nested transfer(caller → pool) — adapter auth pattern matches"
      elif echo "$SIM" | grep -q "transfer_from"; then
        echo " ✗ pool pulls via transfer_from/allowance — adapter must approve first; DO NOT ARM"; ok=0
      else
        echo " ? could not observe the pull mechanism (sim output below) — inspect before arming"
        echo "$SIM" | grep -i "fn_call\|error" | head -8
      fi
    else
      echo " ! factory has no pools yet — ABI checks on a pool skipped; re-run once one exists"
    fi
    [ "$ok" = 1 ] && echo "PREFLIGHT OK — safe to arm" || { echo "PREFLIGHT FAILED"; exit 2; }
    ;;

  arm)
    FACTORY="${2:?usage: curve.sh arm <FACTORY>}"
    need_adapter
    echo "Arming adapter $ADAPTER with factory $FACTORY on $NET…"
    inv "$ADAPTER" -- set_factory --new_factory "$FACTORY" >/dev/null
    echo " ✓ set_factory done"
    echo " get_factory = $(view "$ADAPTER" get_factory)"
    COUNT="$(view "$FACTORY" pool_count)"
    if [ "${COUNT:-0}" -gt 0 ] 2>/dev/null; then
      REG="$(view "$FACTORY" pool_registration --pool_index 0)"
      C0="$(echo "$REG" | sed -n 's/.*"coins":\["\([A-Z0-9]*\)","\([A-Z0-9]*\)".*/\1/p')"
      C1="$(echo "$REG" | sed -n 's/.*"coins":\["\([A-Z0-9]*\)","\([A-Z0-9]*\)".*/\2/p')"
      echo " adapter.quote(coin0 → coin1, 1.0) = $(view "$ADAPTER" quote --token_in "$C0" --token_out "$C1" --amount_in 10000000)"
    fi
    echo "Backend picks the factory up on its next discovery refresh (≤10 min);"
    echo "watch /api/health → curve.armed:true, curve.pools > 0."
    ;;

  derive)
    ADMIN="${2:?usage: curve.sh derive <ADMIN_G...>}"
    # Curve's scripts/deploy/lib.sh: FACTORY_SALT = sha256("curve-stableswap-factory"),
    # factory id = deployer(ADMIN).with_salt(SALT). Same admin -> same address, any network.
    SALT=a0ace7105fb5b2a533369442bb55c1a32e564a072515a950888111c853238254
    echo "Curve factory for admin $ADMIN on $NET:"
    echo "  $(stellar contract id wasm --network "$NET" --salt "$SALT" --source-account "$ADMIN" 2>/dev/null)"
    echo "Once Curve announces the admin key, this is the FACTORY to preflight/arm the moment pool_count > 0."
    ;;

  status)
    need_adapter
    echo " adapter     = $ADAPTER"
    echo " get_factory = $(view "$ADAPTER" get_factory)"
    echo " router venues = $(view "$ROUTER" get_venues)"
    echo " venue $VENUE_ID → $(view "$ROUTER" get_venue --venue_id "$VENUE_ID")"
    ;;

  *)
    sed -n '2,18p' "$0"; exit 1 ;;
esac
