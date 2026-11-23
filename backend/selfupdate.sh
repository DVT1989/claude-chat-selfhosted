#!/bin/sh
# Rebuild and restart compose services from a detached helper container.
# The admin chat runs inside the backend container, so a plain `docker compose up -d --build backend`
# from here would kill itself halfway (old container stopped, new one never created).
# --no-deps: only the named services are recreated, never postgres/redis.
P=${PROJECT_DIR:-/volume1/docker/claude-chat}
LOG=$P/.selfupdate.log
NAME=claude-chat-selfupdate

if [ "$1" = "--log" ]; then
  cat "$LOG" 2>/dev/null || echo "Nog geen selfupdate gedaan."
  exit 0
fi
if [ $# -eq 0 ]; then
  echo "Gebruik: selfupdate <backend|frontend|nginx> [...]  of  selfupdate --log" >&2
  exit 2
fi
for s in "$@"; do
  case "$s" in backend|frontend|nginx|--force) ;; *) echo "Onbekende service: $s" >&2; exit 2 ;; esac
done
# Restarting the backend stops every Claude run in it, agents included. Warn unless --force.
FORCE=0
for s in "$@"; do [ "$s" = "--force" ] && FORCE=1; done
set -- $(for s in "$@"; do [ "$s" != "--force" ] && printf '%s ' "$s"; done)
case " $* " in *" backend "*)
  if [ $FORCE -eq 0 ]; then
    BUSY=$(docker exec -e EXCL="${CC_CONVERSATION_ID:-}" claude-chat-backend-1 sh -c 'curl -s -m 5 -H "x-internal-key: $INTERNAL_API_KEY" "http://127.0.0.1:4000/internal/active-agents?exclude=$EXCL"' 2>/dev/null \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{for(const a of JSON.parse(d).agents)console.log("  - "+a.agentName+": "+a.task+" ("+a.minutes+" min bezig)")}catch{}})' 2>/dev/null)
    if [ -n "$BUSY" ]; then
      echo "Let op: deze agents zijn nog bezig en worden afgebroken als de backend herstart:" >&2
      echo "$BUSY" >&2
      echo "Wacht tot ze klaar zijn, of herstart toch met: selfupdate --force $*" >&2
      exit 3
    fi
  fi ;;
esac
if [ "$(docker inspect -f '{{.State.Running}}' $NAME 2>/dev/null)" = "true" ]; then
  echo "Er loopt al een selfupdate. Bekijk: selfupdate --log" >&2
  exit 1
fi
docker rm -f $NAME >/dev/null 2>&1

# The conversation that asked for the update (set by the app in every Claude run). The restart notice
# passes it on, so after a backend restart that conversation continues by itself and checks the result.
CONV=$(printf '%s' "${CC_CONVERSATION_ID:-}" | tr -cd '0-9a-f-' | cut -c1-36)

# Build first (old containers keep serving), then announce a countdown to every open client
# (POST /internal/restart-notice inside the backend, with the conversation to continue afterwards),
# wait, and only then recreate the containers.
# A failed build never restarts anything.
HELPER='{
  echo "start $(date)"
  if docker compose build $SVCS; then
    json=$(printf "{\"seconds\":%s,\"services\":\"%s\",\"conversationId\":\"%s\"}" "$WAIT" "$SVCS" "$CONV")
    docker exec -e BODY="$json" claude-chat-backend-1 sh -c "curl -s -m 5 -X POST -H \"x-internal-key: \$INTERNAL_API_KEY\" -H \"Content-Type: application/json\" -d \"\$BODY\" http://127.0.0.1:4000/internal/restart-notice" || true
    echo; echo "aankondiging verstuurd, herstart over ${WAIT}s"
    sleep "$WAIT"
    docker compose up -d --no-deps $SVCS
    echo "exit $? $(date)"
  else
    echo "build mislukt, niets herstart"; echo "exit 1 $(date)"
  fi
} > '"$LOG"' 2>&1'

IMG=$(docker inspect -f '{{.Config.Image}}' claude-chat-backend-1)
docker run -d --rm --no-healthcheck --name $NAME \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $P:$P -w $P \
  ${DOCKER_API_VERSION:+-e DOCKER_API_VERSION=$DOCKER_API_VERSION} \
  -e SVCS="$*" -e WAIT="${SELFUPDATE_WAIT:-10}" -e CONV="$CONV" \
  --entrypoint sh "$IMG" \
  -c "$HELPER" >/dev/null \
  && echo "selfupdate gestart voor: $*. Voortgang: selfupdate --log"
