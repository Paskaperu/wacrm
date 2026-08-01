#!/bin/bash
set -euo pipefail
cd /opt/apps/wacrm
set -a; source .env; set +a
docker build -t wacrm \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  --build-arg NEXT_PUBLIC_META_APP_ID="$NEXT_PUBLIC_META_APP_ID" \
  --build-arg NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID="$NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID" \
  .
docker stop wacrm && docker rm wacrm
docker run -d --name wacrm -p 3010:3000 --env-file .env -e HOSTNAME=0.0.0.0 wacrm
