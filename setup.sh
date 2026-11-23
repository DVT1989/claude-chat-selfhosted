#!/bin/sh
# One-time setup: .env with random secrets and a self-signed code signing certificate for the device agent.
set -e
cd "$(dirname "$0")"
rnd() { openssl rand -hex "$1"; }
if [ ! -f .env ]; then
  url="${1:-http://localhost:15980}"
  sed -e "s#^APP_URL=.*#APP_URL=$url#" \
      -e "s#^PROJECT_DIR=.*#PROJECT_DIR=$(pwd)#" \
      -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$(rnd 24)#" \
      -e "s#^REDIS_PASSWORD=.*#REDIS_PASSWORD=$(rnd 24)#" \
      -e "s#^JWT_SECRET=.*#JWT_SECRET=$(rnd 64)#" \
      -e "s#^ENCRYPTION_KEY=.*#ENCRYPTION_KEY=$(rnd 32)#" \
      -e "s#^INTERNAL_API_KEY=.*#INTERNAL_API_KEY=$(rnd 32)#" \
      .env.example > .env
  chmod 600 .env
  echo "Created .env (APP_URL=$url, PROJECT_DIR=$(pwd))"
else
  echo ".env exists, left alone"
fi
mkdir -p signing import
if [ ! -s signing/codesign.key ]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
    -keyout signing/codesign.key -out signing/codesign.crt \
    -subj "/CN=Claude Chat Agent" -addext "extendedKeyUsage=codeSigning" >/dev/null 2>&1
  chmod 600 signing/codesign.key
  echo "Created self-signed code signing certificate in signing/"
fi
echo "Next: docker compose up -d --build"
