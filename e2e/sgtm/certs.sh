#!/bin/sh
# Writes a self-signed certificate for the test site and the preview server's hostnames to /certs, for nginx. Run by
# the stack's certs service (docker-compose.yml) on every start. The tests accept it (ignoreHTTPSErrors); a browser
# shows a warning you can click through.
set -eu
apk add --no-cache openssl > /dev/null
openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
  -keyout /certs/site.key -out /certs/site.crt \
  -subj "/CN=${SITE_HOST}" \
  -addext "subjectAltName=DNS:${SITE_HOST},DNS:${PREVIEW_HOST}" 2> /dev/null
chmod 644 /certs/site.crt /certs/site.key
echo "certificate for ${SITE_HOST} and ${PREVIEW_HOST} written"
