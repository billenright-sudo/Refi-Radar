"use strict";
// Makes a VAPID key pair for the rate-drop phone notifications. The PRIVATE key goes to stdout and nothing else does, so it can be piped
// straight into Secret Manager without ever being shown or saved; the PUBLIC key (not a secret) goes to stderr, for a redirect
// (2> file). Nothing is written to disk by this script. Run from the repo root:
//   node server/scripts/vapid-keys.js 2> ~/vapid-public.txt | gcloud secrets create VAPID_PRIVATE_KEY --data-file=- --project <project>
const { makeVapidKeys } = require("../lib/pings/push");

const { publicKey, privateKey } = makeVapidKeys();
process.stdout.write(privateKey);
process.stderr.write(`${publicKey}\n`);
