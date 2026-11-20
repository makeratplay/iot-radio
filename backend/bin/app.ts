import * as cdk from 'aws-cdk-lib';
import { RadioStack } from '../lib/radio-stack';
const app = new cdk.App();
new RadioStack(app, 'IotRadioStack', { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION } });
