# IoT Radio

ESP32-C6 internet radio with an Amplify-hosted web console and AWS control plane.

## Layout
- `firmware/`: ESP32-C6 Arduino firmware integration notes and MQTT protocol
- `webapp/`: Vite + React web console
- `backend/`: AWS CDK (TypeScript), API Gateway, Lambda, DynamoDB, Google JWT authorizer, AppSync Events and IoT Core policy
- `iot/`: provisioning and device setup

Audio is streamed **directly from station to ESP32**, never through AWS.

## Deploy
1. Install Node.js 20+ and AWS CLI v2. Configure AWS credentials for your account.
2. In Google Cloud, create an OAuth client of type **Web application**. Add authorized JavaScript origins for `http://localhost:5173` and the Amplify app origin. Copy the client ID (`….apps.googleusercontent.com`).
3. Put `GOOGLE_CLIENT_ID` and `IOT_DATA_ENDPOINT` in `secrets/.env` (start from `secrets/.env.example`). Then `cd backend && npm install && npm run build && npx cdk bootstrap && npm run deploy`. CDK uses the `personal` AWS profile from `backend/cdk.json`.
4. Record the `ApiUrl` and `TableName` outputs. Put `ApiUrl` in `secrets/.env` as `VITE_API_URL`.
5. `cd ../webapp && npm install && npm run dev`. The console reads `secrets/.env`. Sign in with Google. The page shows your Google subject; that value is the device owner id.
6. In Amplify Hosting, connect this GitHub repo and use the root `amplify.yml`. Set `VITE_API_URL` and `VITE_GOOGLE_CLIENT_ID`. Add that Amplify origin on the Google OAuth client.
7. Follow `iot/README.md` to provision a unique X.509 certificate and IoT Thing per radio.
8. Adapt the **existing working Arduino sketch** using `firmware/README.md`; do not commit private keys or Wi-Fi credentials.

## Security and scope
This is a bootstrap, not production-hardened firmware. The HTTP API authorizes Google ID tokens. The browser sends the ID token from Sign in with Google; API Gateway checks the issuer `https://accounts.google.com` and the OAuth client audience. IoT device certificates use per-Thing permissions. AppSync Events is provisioned for future live status, but its browser subscription and signed publishing are not yet wired into the webapp. Current UI polls the API. No AWS credentials, private keys or device secrets belong in git.

## Local checks
`cd backend && npm run build`; `cd webapp && npm run build`.

MIT licensed. See LICENSE.
