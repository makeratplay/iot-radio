# IoT Radio

ESP32-C6 internet radio with an Amplify-hosted web console and AWS control plane.

## Layout
- `firmware/`: ESP32-C6 Arduino firmware integration notes and MQTT protocol
- `webapp/`: Vite + React web console
- `backend/`: AWS CDK (TypeScript), API Gateway, Lambda, DynamoDB, Cognito, AppSync Events and IoT Core policy
- `iot/`: provisioning and device setup

Audio is streamed **directly from station to ESP32**, never through AWS.

## Deploy
1. Install Node.js 20+ and AWS CLI v2. Configure AWS credentials for your account.
2. `cd backend && npm install && npm run build && npx cdk bootstrap && npm run deploy`.
3. Record CloudFormation outputs. Create a Cognito user in the deployed user pool.
4. `cd ../webapp && npm install && cp .env.example .env.local`. Set the output values, then `npm run dev`.
5. In Amplify Hosting, connect this GitHub repo and use the root `amplify.yml`. Set VITE_* environment variables there.
6. Follow `iot/README.md` to provision a unique X.509 certificate and IoT Thing per radio.
7. Adapt the **existing working Arduino sketch** using `firmware/README.md`; do not commit private keys or Wi-Fi credentials.

## Security and scope
This is a bootstrap, not production-hardened firmware. HTTP API uses Cognito JWT authorization. IoT device certificates use per-Thing permissions. AppSync Events is provisioned for future live status, but its browser subscription and signed publishing are not yet wired into the webapp. Current UI polls the API. No AWS credentials, private keys or device secrets belong in git.

## Local checks
`cd backend && npm run build`; `cd webapp && npm run build`.

MIT licensed. See LICENSE.
