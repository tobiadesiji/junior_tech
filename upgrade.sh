#!/usr/bin/env bash
# Run on the existing Ubuntu Docker host. Does not read or print a key value.
set -euo pipefail
cd "$(dirname "$0")"
existing_env_file="${1:-}"
if [[ -z "$existing_env_file" || ! -r "$existing_env_file" ]]; then
  printf 'Usage: bash upgrade.sh /path/to/existing-key.env\nThe existing env file must supply OPENAI_API_KEY. Do not paste its contents into chat.\n' >&2
  exit 1
fi
read -r -p 'Email of your existing parent account to use as administrator: ' ezra_admin_email
if [[ "$ezra_admin_email" != *@*.* ]]; then printf 'Enter the email used for your parent account.\n' >&2; exit 1; fi
volume_name=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' ezra-training)
if [[ -z "$volume_name" ]]; then printf 'No named data volume found on ezra-training. Stopped before changing anything.\n' >&2; exit 1; fi
if ! docker exec ezra-training node --input-type=module -e 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.env.DB_PATH,{readOnly:true});const yes=db.prepare("SELECT 1 FROM parents WHERE lower(email)=?").get(process.argv[1].trim().toLowerCase());db.close();process.exit(yes?0:1)' "$ezra_admin_email"; then
  printf 'That email does not match an existing parent account. Stopped before changing anything.\n' >&2; exit 1
fi
stamp=$(date -u +%Y%m%d-%H%M%S)
backup_name="before-v0.2.0-$stamp.sqlite"
mkdir -p backups
chmod 700 backups
docker exec ezra-training node backup.mjs "/app/data/$backup_name"
docker cp "ezra-training:/app/data/$backup_name" "backups/$backup_name"
chmod 600 "backups/$backup_name"
docker build -t ezra-training:0.2.0 .
if ! docker run --rm --env-file "$existing_env_file" ezra-training:0.2.0 node -e 'process.exit(process.env.OPENAI_API_KEY ? 0 : 1)'; then
  printf 'The selected env file does not supply OPENAI_API_KEY. Existing app is unchanged.\n' >&2
  exit 1
fi
previous_container="ezra-training-before-$stamp"
docker stop ezra-training
docker rename ezra-training "$previous_container"
rollback() {
  trap - ERR
  printf 'Upgrade did not become healthy. Restoring the previous container.\n' >&2
  docker stop ezra-training >/dev/null 2>&1 || true
  docker rm ezra-training >/dev/null 2>&1 || true
  docker rename "$previous_container" ezra-training
  docker start ezra-training
  exit 1
}
trap rollback ERR
docker run -d \
  --name ezra-training \
  --restart unless-stopped \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  -p 192.168.1.139:3080:3000 \
  --env-file "$existing_env_file" \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e DB_PATH=/app/data/academy.sqlite \
  -e APP_ORIGIN=https://learning.createdtocreate.uk \
  -e ADMIN_EMAIL="$ezra_admin_email" \
  -e ALLOW_REGISTRATION=false \
  -e OPENAI_ZDR_CONFIRMED=false \
  -v "$volume_name:/app/data" \
  ezra-training:0.2.0
healthy=false
for attempt in {1..30}; do
  if docker exec ezra-training node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then healthy=true; break; fi
  sleep 1
done
if [[ "$healthy" != true ]]; then false; fi
trap - ERR
printf '\nUpgrade healthy. Open https://learning.createdtocreate.uk and refresh.\n'
printf 'Previous container retained: %s\nDatabase backup: backups/%s\n' "$previous_container" "$backup_name"
docker exec ezra-training node -e "console.log('AI key configured:',Boolean(process.env.OPENAI_API_KEY))"
