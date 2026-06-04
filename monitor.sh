#!/bin/bash
# OpenCode Railway Smart Monitor - v5.1
# Detects real external activity via the wrapper instead of internal SSE bus noise.

set -uo pipefail

# ==================== Configuration ====================
IDLE_TIME_MINUTES=${IDLE_TIME_MINUTES:-10}
CHECK_INTERVAL_SECONDS=${CHECK_INTERVAL_SECONDS:-60}
MEMORY_THRESHOLD_MB=${MEMORY_THRESHOLD_MB:-2000}
LOG_FILE="${LOG_FILE:-/tmp/opencode_monitor_script.log}"
STATE_DIR="/tmp/opencode_monitor_state_v5"
LOG_SLEEP_BLOCKERS=${LOG_SLEEP_BLOCKERS:-false}
SLEEP_NET_LOG_IDLE_MINUTES=${SLEEP_NET_LOG_IDLE_MINUTES:-1}
SLEEP_NET_LOG_MAX_LINES=${SLEEP_NET_LOG_MAX_LINES:-80}
mkdir -p "$STATE_DIR"

LAST_ACTIVITY_FILE="$STATE_DIR/last_activity"

RAILWAY_API_TOKEN="${RAILWAY_API_TOKEN:-}"
# These are automatically injected by Railway - no need to set manually
RAILWAY_PROJECT_ID="${RAILWAY_PROJECT_ID:-}"
RAILWAY_ENVIRONMENT_ID="${RAILWAY_ENVIRONMENT_ID:-}"
RAILWAY_SERVICE_ID="${RAILWAY_SERVICE_ID:-}"

log() {
    local msg="$1"
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $msg" | tee -a "$LOG_FILE"
}

echo "========================================"
echo "🚂 OpenCode Railway Monitor v5.1"
echo "========================================"

get_current_deployment_id() {
    local graphql_query='{"query": "query deployments($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status } } } }", "variables": { "input": { "projectId": "'"$RAILWAY_PROJECT_ID"'", "serviceId": "'"$RAILWAY_SERVICE_ID"'", "environmentId": "'"$RAILWAY_ENVIRONMENT_ID"'" } } }'
    
    local response
    response=$(curl -s -X POST https://backboard.railway.com/graphql/v2 \
        -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$graphql_query" 2>&1)
    
    # Extract deployment ID from response
    local deployment_id=$(echo "$response" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"$//')
    
    if [ -n "$deployment_id" ]; then
        echo "$deployment_id"
        return 0
    else
        return 1
    fi
}

trigger_deployment_restart() {
    log "  🚀 Calling Railway API to restart current deployment..."
    
    if [ -z "$RAILWAY_API_TOKEN" ] || [ -z "$RAILWAY_PROJECT_ID" ] || [ -z "$RAILWAY_ENVIRONMENT_ID" ] || [ -z "$RAILWAY_SERVICE_ID" ]; then
        log "  ⚠️ Required environment variables are not set, skipping API restart"
        log "     Please set: RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID"
        return 1
    fi
    
    # Get current deployment ID
    local deployment_id
    deployment_id=$(get_current_deployment_id)
    
    if [ -z "$deployment_id" ]; then
        log "  ⚠️ Failed to get current deployment ID, trying redeploy..."
        trigger_railway_redeploy
        return $?
    fi
    
    log "  📦 Current deployment ID: $deployment_id"
    
    local graphql_query='{"query": "mutation deploymentRestart($id: String!) { deploymentRestart(id: $id) }", "variables": { "id": "'"$deployment_id"'" } }'
    
    local response
    response=$(curl -s -X POST https://backboard.railway.com/graphql/v2 \
        -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$graphql_query" 2>&1)
    
    local http_code=$?
    
    if [ $http_code -eq 0 ] && echo "$response" | grep -q "deploymentRestart"; then
        log "  ✅ Railway deployment restart triggered"
        return 0
    else
        log "  ⚠️ Railway API call failed: $response"
        log "  🔄 Trying redeploy..."
        trigger_railway_redeploy
        return $?
    fi
}

trigger_railway_redeploy() {
    log "  🚀 Calling Railway API to trigger redeploy..."
    
    if [ -z "$RAILWAY_API_TOKEN" ] || [ -z "$RAILWAY_PROJECT_ID" ] || [ -z "$RAILWAY_ENVIRONMENT_ID" ] || [ -z "$RAILWAY_SERVICE_ID" ]; then
        log "  ⚠️ Required environment variables are not set, skipping API deploy"
        log "     Please set: RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID"
        return 1
    fi
    
    local graphql_query='{"query": "mutation environmentTriggersDeploy($input: EnvironmentTriggersDeployInput!) { environmentTriggersDeploy(input: $input) }", "variables": { "input": { "projectId": "'"$RAILWAY_PROJECT_ID"'", "environmentId": "'"$RAILWAY_ENVIRONMENT_ID"'", "serviceId": "'"$RAILWAY_SERVICE_ID"'" } } }'
    
    local response
    response=$(curl -s -X POST https://backboard.railway.com/graphql/v2 \
        -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$graphql_query" 2>&1)
    
    local http_code=$?
    
    if [ $http_code -eq 0 ] && echo "$response" | grep -q "environmentTriggersDeploy"; then
        log "  ✅ Railway redeploy triggered"
        return 0
    else
        log "  ⚠️ Railway API call failed: $response"
        return 1
    fi
}

# ==================== Get OpenCode Process ID ====================
get_opencode_pid() {
    local pid

    # OpenCode is always launched from the source-built binary via `opencode serve`.
    pid=$(ps -eo pid=,args= | awk '/(^|[[:space:]\/])opencode([[:space:]]|$)/ && / serve([[:space:]]|$)/ { print $1; exit }')
    if [ -n "$pid" ]; then
        echo "$pid"
        return
    fi
}

state_name() {
    case "$1" in
        01) echo "ESTABLISHED" ;;
        02) echo "SYN_SENT" ;;
        03) echo "SYN_RECV" ;;
        04) echo "FIN_WAIT1" ;;
        05) echo "FIN_WAIT2" ;;
        06) echo "TIME_WAIT" ;;
        07) echo "CLOSE" ;;
        08) echo "CLOSE_WAIT" ;;
        09) echo "LAST_ACK" ;;
        0A) echo "LISTEN" ;;
        0B) echo "CLOSING" ;;
        *) echo "$1" ;;
    esac
}

decode_ipv4() {
    local hex="$1"
    printf '%d.%d.%d.%d' \
        "$((16#${hex:6:2}))" \
        "$((16#${hex:4:2}))" \
        "$((16#${hex:2:2}))" \
        "$((16#${hex:0:2}))"
}

decode_endpoint() {
    local value="$1"
    local proto="$2"
    local ip_hex="${value%:*}"
    local port_hex="${value#*:}"
    local port=$((16#$port_hex))

    if [ "$proto" = "tcp" ]; then
        echo "$(decode_ipv4 "$ip_hex"):$port"
        return
    fi

    echo "[$ip_hex]:$port"
}

load_socket_owners() {
    SOCKET_OWNER=()
    SOCKET_CMD=()

    local proc pid comm cmd fd target inode
    for proc in /proc/[0-9]*; do
        [ -d "$proc" ] || continue
        pid="${proc##*/}"
        comm=$(tr -d '\0' < "$proc/comm" 2>/dev/null || true)
        cmd=$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)
        cmd="${cmd:0:160}"
        cmd="${cmd//\"/_}"

        for fd in "$proc"/fd/*; do
            [ -e "$fd" ] || continue
            target=$(readlink "$fd" 2>/dev/null || true)
            case "$target" in
                socket:\[*\])
                    inode="${target#socket:[}"
                    inode="${inode%]}"
                    if [ -z "${SOCKET_OWNER[$inode]:-}" ]; then
                        SOCKET_OWNER[$inode]="$pid/${comm:-unknown}"
                        SOCKET_CMD[$inode]="$cmd"
                    fi
                    ;;
            esac
        done
    done
}

log_tcp_file() {
    local file="$1"
    local proto="$2"
    local max="$3"
    local count_ref="$4"
    local line sl local_addr remote_addr state inode local_ep remote_ep owner cmd state_text

    [ -r "$file" ] || return

    while read -r line; do
        set -- $line
        sl="${1:-}"
        [ "$sl" = "sl" ] && continue

        local_addr="${2:-}"
        remote_addr="${3:-}"
        state="${4:-}"
        inode="${10:-}"

        [ -n "$local_addr" ] || continue
        [ -n "$remote_addr" ] || continue
        [ -n "$inode" ] || continue
        [ "$state" = "0A" ] && continue
        [ "$remote_addr" = "00000000:0000" ] && continue
        [ "$remote_addr" = "00000000000000000000000000000000:0000" ] && continue

        if [ "${!count_ref}" -ge "$max" ]; then
            return
        fi

        local_ep=$(decode_endpoint "$local_addr" "$proto")
        remote_ep=$(decode_endpoint "$remote_addr" "$proto")
        owner="${SOCKET_OWNER[$inode]:-unknown}"
        cmd="${SOCKET_CMD[$inode]:--}"
        state_text=$(state_name "$state")

        log "[sleep-net] proto=$proto state=$state_text local=$local_ep remote=$remote_ep inode=$inode owner=$owner cmd=\"$cmd\""
        printf -v "$count_ref" '%s' "$(( ${!count_ref} + 1 ))"
    done < "$file"
}

log_tcp_snapshot() {
    local idle_time="$1"
    local pressure_mem="$2"
    local total_mem="$3"
    local cache_mem="$4"
    local pid="$5"

    [ "$LOG_SLEEP_BLOCKERS" = "true" ] || return
    [ "$idle_time" -ge "$SLEEP_NET_LOG_IDLE_MINUTES" ] || return

    declare -gA SOCKET_OWNER
    declare -gA SOCKET_CMD
    load_socket_owners

    local count=0
    log "[sleep-net] snapshot idle=${idle_time}m pressure_memory=${pressure_mem}MB total_memory=${total_mem}MB file_cache=${cache_mem}MB opencode_pid=${pid:-unknown} max_lines=$SLEEP_NET_LOG_MAX_LINES"
    log_tcp_file /proc/net/tcp tcp "$SLEEP_NET_LOG_MAX_LINES" count
    log_tcp_file /proc/net/tcp6 tcp6 "$SLEEP_NET_LOG_MAX_LINES" count
    if [ "$count" -eq 0 ]; then
        log "[sleep-net] no active non-listening tcp sockets"
    fi
    if [ "$count" -ge "$SLEEP_NET_LOG_MAX_LINES" ]; then
        log "[sleep-net] truncated active tcp socket list at $SLEEP_NET_LOG_MAX_LINES lines"
    fi
}

# ==================== Check Active Sessions ====================
# Queries OpenCode's internal /session/status API to detect busy/retry sessions.
# SessionStatus is per-workspace (InstanceState keyed by directory), so we
# iterate over all workspace directories to check for active sessions in any of
# them. This catches long-running tasks (e.g. bash commands, shell loops,
# external waits) that don't generate HTTP requests or log patterns tracked by
# server.js.
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/data/workspace}"
check_session_active() {
    local internal_port="${INTERNAL_PORT:-18080}"
    local response

    for dir in "$WORKSPACE_ROOT" "$WORKSPACE_ROOT"/*/; do
        [ -d "$dir" ] || continue
        response=$(curl -s -m 5 -H "x-opencode-directory: $dir" \
            "http://127.0.0.1:${internal_port}/session/status" 2>/dev/null)
        if [ -n "$response" ] && echo "$response" | grep -qE '"type"\s*:\s*"(busy|retry)"'; then
            return 0
        fi
    done

    return 1
}

# ==================== Get Memory Usage ====================
get_cgroup_stat_bytes() {
    local key="$1"

    [ -f /sys/fs/cgroup/memory.stat ] || return 1
    awk -v key="$key" '$1 == key { print $2; found = 1; exit } END { if (!found) exit 1 }' /sys/fs/cgroup/memory.stat 2>/dev/null
}

get_total_memory_mb() {
    if [ -f /sys/fs/cgroup/memory.current ]; then
        local total_bytes
        total_bytes=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0)
        echo $((total_bytes / 1024 / 1024))
        return
    fi

    local pid
    pid=$(get_opencode_pid)
    if [ -n "$pid" ]; then
        local rss_kb
        rss_kb=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0)
        echo $((rss_kb / 1024))
        return
    fi

    echo 0
}

get_pressure_memory_mb() {
    local anon_bytes kernel_bytes

    anon_bytes=$(get_cgroup_stat_bytes anon || echo 0)
    kernel_bytes=$(get_cgroup_stat_bytes kernel || echo 0)
    if [ "$anon_bytes" -gt 0 ] || [ "$kernel_bytes" -gt 0 ]; then
        echo $(((anon_bytes + kernel_bytes) / 1024 / 1024))
        return
    fi

    get_total_memory_mb
}

get_file_cache_mb() {
    local file_bytes

    file_bytes=$(get_cgroup_stat_bytes file || echo 0)
    echo $((file_bytes / 1024 / 1024))
}

get_memory_mb() {
    get_pressure_memory_mb
}

# ==================== Activity File Helpers ====================
touch_activity() {
    local ts
    ts=$(date +%s)
    if [ -z "$ts" ] || [ "$ts" -le 0 ] 2>/dev/null; then
        log "  ⚠️ Invalid timestamp from date, skipping activity update"
        return 1
    fi
    printf '%s' "$ts" > "$LAST_ACTIVITY_FILE"
}

read_activity() {
    if [ ! -f "$LAST_ACTIVITY_FILE" ]; then
        touch_activity
        cat "$LAST_ACTIVITY_FILE"
        return
    fi

    local val
    val=$(cat "$LAST_ACTIVITY_FILE" 2>/dev/null)
    if [ -z "$val" ] || [ "$val" -le 0 ] 2>/dev/null; then
        log "  ⚠️ Corrupted activity file (value='$val'), resetting to now"
        touch_activity
        cat "$LAST_ACTIVITY_FILE"
        return
    fi

    echo "$val"
}

# ==================== Restart ====================
restart_opencode() {
    local reason="$1"
    local mem_before
    mem_before=$(get_memory_mb)
    
    log "========================================"
    log "🔄 Triggering OpenCode redeploy"
    log "  Reason: $reason"
    log "  Current memory: ${mem_before}MB"
    
    rm -f "$LAST_ACTIVITY_FILE"
    
    # Call Railway API directly to trigger deployment restart
    trigger_deployment_restart
    
    log "  ✅ Deployment restart request sent"
    log "========================================"
    
    sleep 60
}

# ==================== Main Loop ====================
main() {
    local start_time
    start_time=$(date +%s)
    local check_count=0
    
    # Initialize activity timestamp
    read_activity > /dev/null

    log "🚀 Monitor started"
    
    while true; do
        check_count=$((check_count + 1))
        
        pid=$(get_opencode_pid)
        if [ -z "$pid" ]; then
            sleep "$CHECK_INTERVAL_SECONDS"
            continue
        fi
        
        local pressure_mem total_mem cache_mem
        pressure_mem=$(get_pressure_memory_mb)
        total_mem=$(get_total_memory_mb)
        cache_mem=$(get_file_cache_mb)
        local uptime
        uptime=$(($(date +%s) - start_time))
        local uptime_hours=$((uptime / 3600))
        
        # Check real session state via OpenCode API
        if check_session_active; then
            touch_activity
        fi

        if [ -f "$LAST_ACTIVITY_FILE" ]; then
            local last_activity
            last_activity=$(read_activity)
            local current=$(date +%s)
            local idle_time=$(( (current - last_activity) / 60 ))

            if [ $((check_count % 10)) -eq 0 ]; then
                log "ℹ️ Status: idle=${idle_time}m pressure_memory=${pressure_mem}MB total_memory=${total_mem}MB file_cache=${cache_mem}MB uptime=${uptime_hours}h"
            fi

            log_tcp_snapshot "$idle_time" "$pressure_mem" "$total_mem" "$cache_mem" "$pid"
            
            if [ $idle_time -ge "$IDLE_TIME_MINUTES" ] && [ "$pressure_mem" -gt "$MEMORY_THRESHOLD_MB" ]; then
                log "💤 Idle for ${idle_time} minutes with pressure memory at ${pressure_mem}MB (total=${total_mem}MB file_cache=${cache_mem}MB), restarting"
                restart_opencode "idle with high pressure memory"
            fi
        fi
        
        sleep "$CHECK_INTERVAL_SECONDS"
    done
}

trap 'log "🛑 Monitor exiting"; exit 0' SIGINT SIGTERM
main "$@"
