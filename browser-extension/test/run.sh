#!/bin/bash
# E2E-test: Chromium (Playwright-image) met de extensie tegen een testbackend (netwerk bt-net, alias backend-test).
# Stap 1: ./run.sh start CODE   -> start de testhost op de achtergrond (container bt-pw)
# Stap 2: roep de /devices/claude-API aan vanuit de testbackend (docker exec bt-backend curl ...)
# Stap 3: ./run.sh stop         -> sluit af en toont de pagina-status
D=$(cd "$(dirname "$0")" && pwd); PW=mcr.microsoft.com/playwright:v1.49.1-noble
case "$1" in
  start) docker rm -f bt-pw >/dev/null 2>&1
    docker run -d --name bt-pw --network bt-net -e SERVER=http://backend-test:4000 -e CODE="$2" -e HOLD=${HOLD:-300} \
      -v "$D/..":/ext:ro -v "$D":/t:ro -w /tmp $PW bash -c 'cp /t/e2e-host.mjs .; npm i playwright@1.49.1 >/dev/null 2>&1; node e2e-host.mjs' ;;
  stop) docker exec bt-pw touch /tmp/stop; sleep 4; docker logs bt-pw; docker rm -f bt-pw >/dev/null ;;
esac
