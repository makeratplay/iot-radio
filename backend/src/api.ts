import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { IoTDataPlaneClient, PublishCommand, GetThingShadowCommand } from '@aws-sdk/client-iot-data-plane';
import { randomUUID } from 'crypto';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = process.env.TABLE_NAME!;
const endpoint = process.env.IOT_ENDPOINT!;
const iot = new IoTDataPlaneClient({ endpoint: endpoint ? 'https://' + endpoint : undefined });
const json = (statusCode: number, data: unknown) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
});
const validDevice = (id: string) => /^radio-[a-zA-Z0-9_-]{1,64}$/.test(id);
const validStream = (url: unknown) => typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url) && url.length <= 500;

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async event => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const owner = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof owner !== 'string') return json(401, { error: 'Unauthorized' });
  try {
    if (path === '/stations' && method === 'GET') {
      const result = await db.send(new ScanCommand({ TableName: table, FilterExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'USER#' + owner } }));
      return json(200, { items: (result.Items || []).filter(i => i.sk?.startsWith('STATION#')).map(i => ({ id: i.id, name: i.name, url: i.url })) });
    }
    if (path === '/stations' && method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || !validStream(body.url)) return json(400, { error: 'Invalid station' });
      const id = randomUUID();
      await db.send(new PutCommand({ TableName: table, Item: { pk: 'USER#' + owner, sk: 'STATION#' + id, id, name: body.name.trim(), url: body.url } }));
      return json(201, { id });
    }
    if (path === '/devices' && method === 'GET') {
      const result = await db.send(new ScanCommand({ TableName: table, FilterExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'USER#' + owner } }));
      const devices = (result.Items || []).filter(i => i.sk?.startsWith('DEVICE#'));
      return json(200, { items: await Promise.all(devices.map(async d => {
        try {
          const s = await iot.send(new GetThingShadowCommand({ thingName: d.id }));
          return { id: d.id, state: JSON.parse(new TextDecoder().decode(s.payload)).state };
        } catch { return { id: d.id, state: null }; }
      })) });
    }
    if (path === '/devices' && method === 'POST') {
      // Ownership registration is intentionally NOT a public API. Provision via admin CLI.
      return json(403, { error: 'Use trusted device provisioning workflow' });
    }
    const match = path.match(/^\/devices\/(radio-[a-zA-Z0-9_-]{1,64})\/commands$/);
    if (match && method === 'POST') {
      const id = match[1];
      if (!validDevice(id)) return json(400, { error: 'Invalid device' });
      const ownership = await db.send(new ScanCommand({ TableName: table, FilterExpression: 'pk = :pk AND sk = :sk',
        ExpressionAttributeValues: { ':pk': 'USER#' + owner, ':sk': 'DEVICE#' + id } }));
      if (!ownership.Items?.length) return json(403, { error: 'Device not registered to user' });
      const body = JSON.parse(event.body || '{}');
      if (!['play','stop','set_station','set_volume'].includes(body.command)) return json(400, { error: 'Unsupported command' });
      if (body.command === 'set_station' && !validStream(body.url)) return json(400, { error: 'Invalid URL' });
      if (body.command === 'set_volume' && (!Number.isInteger(body.volume) || body.volume < 0 || body.volume > 100)) return json(400, { error: 'Invalid volume' });
      await iot.send(new PublishCommand({
        topic: 'radio/' + id + '/commands', qos: 1,
        payload: new TextEncoder().encode(JSON.stringify({ ...body, requestId: randomUUID() }))
      }));
      return json(202, { accepted: true });
    }
    return json(404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Internal server error' });
  }
};
