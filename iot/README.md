# IoT Core device provisioning

Each physical radio needs a unique IoT Thing and X.509 certificate. Never share a certificate across manufactured devices.

## Prototype device
Use AWS IoT Core Console to create Thing `radio-demo001`, generate and activate its certificate, attach it to the Thing, and attach the policy in `device-policy.json` after replacing `ACCOUNT_ID`, `REGION`, and `THING_NAME`. Download private key once and store it securely outside Git.

The policy requires MQTT client ID equal to Thing name and limits topic access to that device.

## Data endpoint
Find your account's IoT data ATS endpoint with:
```sh
aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text
```
Pass it as `IOT_DATA_ENDPOINT` to the CDK deploy environment, e.g. `IOT_DATA_ENDPOINT=... npm run deploy`. The Lambda endpoint must be set for command publishing and shadow reads.

## Register device ownership (prototype administrator step)
```sh
aws dynamodb put-item --table-name TABLE_NAME --item '{"pk":{"S":"USER#COGNITO_SUB"},"sk":{"S":"DEVICE#radio-demo001"},"id":{"S":"radio-demo001"}}'
```
Replace TABLE_NAME, COGNITO_SUB and Thing ID. Do not expose this registration operation to unauthenticated users.

## Device protocol
Subscribe: `radio/{thingName}/commands`
Publish: `radio/{thingName}/telemetry`, `radio/{thingName}/responses`
Update reported state: `$aws/things/{thingName}/shadow/update`

The current firmware uses `esp32/demo/commands`; migrate its topic strings before using the web console.

## Future hardening
Implement secure claiming (one-time claim code and ownership proof), Cognito group-based admin operations, AppSync Events Cognito/IAM browser auth, IoT Rules -> Lambda -> AppSync Events for status fan-out, and AWS IoT fleet provisioning for scale.
