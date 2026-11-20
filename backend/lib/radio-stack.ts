import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class RadioStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const table = new dynamodb.Table(this, 'RadioData', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });
    const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (!googleClientId || !googleClientId.endsWith('.apps.googleusercontent.com')) {
      throw new Error('Set GOOGLE_CLIENT_ID in secrets/.env to the Google OAuth web client ID before deploying.');
    }
    const handler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      entry: path.join(__dirname, '../../src/api.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: { TABLE_NAME: table.tableName, IOT_ENDPOINT: process.env.IOT_DATA_ENDPOINT || '' },
      bundling: { minify: true }
    });
    table.grantReadWriteData(handler);
    handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iot:Publish', 'iot:GetThingShadow'],
      resources: [
        this.formatArn({ service: 'iot', resource: 'topic', resourceName: 'radio/*/commands' }),
        this.formatArn({ service: 'iot', resource: 'thing', resourceName: 'radio-*' })
      ]
    }));
    const api = new apigw.HttpApi(this, 'HttpApi', {
      corsPreflight: { allowOrigins: ['*'], allowHeaders: ['authorization','content-type'], allowMethods: [apigw.CorsHttpMethod.ANY] }
    });
    const jwt = new authorizers.HttpJwtAuthorizer('GoogleJwt', 'https://accounts.google.com', {
      jwtAudience: [googleClientId]
    });
    // ANY would include OPTIONS and send the browser preflight through the JWT authorizer.
    // A 401 preflight is reported by the browser as a CORS error.
    api.addRoutes({
      path: '/{proxy+}',
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.PUT, apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE, apigw.HttpMethod.HEAD],
      integration: new integrations.HttpLambdaIntegration('LambdaIntegration', handler),
      authorizer: jwt
    });

    // AppSync Events stays on IAM until a browser client is wired up.
    // Do not add an API key and ship it to the browser.
    const events = new cdk.CfnResource(this, 'EventsApi', {
      type: 'AWS::AppSync::Api',
      properties: { Name: 'iot-radio-events', EventConfig: {
        AuthProviders: [{ AuthType: 'AWS_IAM' }],
        ConnectionAuthModes: [{ AuthType: 'AWS_IAM' }],
        DefaultPublishAuthModes: [{ AuthType: 'AWS_IAM' }],
        DefaultSubscribeAuthModes: [{ AuthType: 'AWS_IAM' }]
      } }
    });
    new cdk.CfnResource(this, 'StatusNamespace', {
      type: 'AWS::AppSync::ChannelNamespace',
      properties: { ApiId: events.getAtt('ApiId').toString(), Name: 'status' }
    });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'GoogleClientId', { value: googleClientId });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'EventsApiId', { value: events.getAtt('ApiId').toString() });
  }
}
