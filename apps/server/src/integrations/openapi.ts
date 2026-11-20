import type { Config } from '../config.js';

/**
 * OpenAPI 2.0 (Swagger) description of the public REST API. Power Apps / Power Automate custom connectors import this format:
 * "API Key" authentication, parameter "Authorization" in the header, value "Bearer bk_...".
 */
export function openApiDocument(cfg: Config) {
  const origin = new URL(cfg.APP_ORIGIN.split(',')[0]!.trim());
  const str = { type: 'string' };
  const int = { type: 'integer' };
  const ts = { type: 'string', format: 'date-time' };
  const id = { type: 'string', format: 'uuid' };
  const idParam = { name: 'id', in: 'path', required: true, type: 'string', format: 'uuid', 'x-ms-summary': 'Conversation id' };
  const errors = { 401: { description: 'Missing or revoked API key' }, 403: { description: 'The key lacks the needed scope' }, 429: { description: 'Too many requests' } };
  const conversation = { type: 'object', properties: {
    id, status: { type: 'string', enum: ['open', 'closed'] }, assignedTo: { type: 'string', format: 'uuid', 'x-nullable': true }, unread: int, lastMessageAt: ts, createdAt: ts,
    tags: { type: 'array', items: str },
    channel: { type: 'object', properties: { id, type: str } },
    contact: { type: 'object', properties: { id, name: { ...str, 'x-nullable': true }, blocked: { type: 'boolean' } } },
  } };
  const message = { type: 'object', properties: { id, seq: int, direction: { type: 'string', enum: ['in', 'out'] }, text: str, auto: { type: 'boolean' }, createdAt: ts, senderUserId: { type: 'string', 'x-nullable': true } } };
  const op = (operationId: string, summary: string, description: string, extra: Record<string, unknown>) => ({ operationId, summary, description, produces: ['application/json'], ...extra });
  return {
    swagger: '2.0',
    info: { title: 'Botwa', description: 'Support inbox: conversations, messages, contacts, statistics and FAQ. Keys are created in Integrations (scopes: read, send, manage).', version: '1.0' },
    host: origin.host,
    basePath: '/',
    schemes: [origin.protocol.replace(':', '')],
    consumes: ['application/json'],
    produces: ['application/json'],
    securityDefinitions: { apiKey: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Bearer followed by the key, e.g. "Bearer bk_..."' } },
    security: [{ apiKey: [] }],
    definitions: { Conversation: conversation, Message: message },
    paths: {
      '/api/v1/me': { get: op('WhoAmI', 'Check the connection', 'The key name and its scopes.', { responses: { 200: { description: 'OK', schema: { type: 'object', properties: { name: str, scopes: { type: 'array', items: str } } } }, ...errors } }) },
      '/api/v1/stats': { get: op('GetStats', 'Statistics', 'Volumes, response times and the daily trend for the last N days.', {
        parameters: [{ name: 'days', in: 'query', type: 'integer', default: 30, minimum: 1, maximum: 365, 'x-ms-summary': 'Days' }],
        responses: { 200: { description: 'OK', schema: { type: 'object', properties: {
          days: int, newConversations: int, inbound: int, outbound: int, openNow: int, unassignedNow: int, answered: int, unanswered: int,
          avgFirstResponseSeconds: { ...int, 'x-nullable': true }, medianFirstResponseSeconds: { ...int, 'x-nullable': true }, slaCompliancePercent: { ...int, 'x-nullable': true },
          daily: { type: 'array', items: { type: 'object', properties: { day: str, inbound: int, outbound: int } } },
          topTags: { type: 'array', items: { type: 'object', properties: { name: str, conversations: int } } },
        } } }, ...errors } }) },
      '/api/v1/conversations': { get: op('ListConversations', 'List conversations', 'Newest first.', {
        parameters: [
          { name: 'status', in: 'query', type: 'string', enum: ['open', 'closed'], required: false, 'x-ms-summary': 'Status' },
          { name: 'updated_since', in: 'query', type: 'string', format: 'date-time', required: false, 'x-ms-summary': 'Changed since' },
          { name: 'limit', in: 'query', type: 'integer', default: 50, minimum: 1, maximum: 100, 'x-ms-summary': 'Limit' },
          { name: 'offset', in: 'query', type: 'integer', default: 0, minimum: 0, 'x-ms-summary': 'Offset' },
        ],
        responses: { 200: { description: 'OK', schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/definitions/Conversation' } }, limit: int, offset: int } } }, ...errors } }) },
      '/api/v1/conversations/{id}': { get: op('GetConversation', 'Get a conversation', '', { parameters: [idParam], responses: { 200: { description: 'OK', schema: { $ref: '#/definitions/Conversation' } }, 404: { description: 'Not found' }, ...errors } }) },
      '/api/v1/conversations/{id}/messages': {
        get: op('ListMessages', 'Messages of a conversation', 'In order; page with after_seq.', {
          parameters: [idParam, { name: 'after_seq', in: 'query', type: 'integer', default: 0, 'x-ms-summary': 'After message number' }, { name: 'limit', in: 'query', type: 'integer', default: 100, minimum: 1, maximum: 200, 'x-ms-summary': 'Limit' }],
          responses: { 200: { description: 'OK', schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/definitions/Message' } }, nextAfterSeq: int } } }, 404: { description: 'Not found' }, ...errors } }),
        post: op('SendReply', 'Reply in a conversation', 'Needs the "send" scope. Blocked, opted-out and outside-the-reply-window customers are refused.', {
          parameters: [idParam, { name: 'body', in: 'body', required: true, schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 4000, 'x-ms-summary': 'Text' } } } }],
          responses: { 201: { description: 'Sent', schema: { type: 'object', properties: { id, seq: int, createdAt: ts } } }, 409: { description: 'Not allowed to write to this customer now' }, ...errors } }),
      },
      '/api/v1/contacts': { get: op('ListContacts', 'List contacts', 'Personal data: every call is recorded in the audit log.', {
        parameters: [{ name: 'q', in: 'query', type: 'string', required: false, 'x-ms-summary': 'Search name or number' }, { name: 'limit', in: 'query', type: 'integer', default: 100, minimum: 1, maximum: 200, 'x-ms-summary': 'Limit' }, { name: 'offset', in: 'query', type: 'integer', default: 0, 'x-ms-summary': 'Offset' }],
        responses: { 200: { description: 'OK', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
          id, name: { ...str, 'x-nullable': true }, externalId: str, channelType: str, channelLabel: str, blocked: { type: 'boolean' }, optedOut: { type: 'boolean' }, createdAt: ts,
          conversationId: { ...str, 'x-nullable': true }, conversationStatus: { ...str, 'x-nullable': true }, lastMessageAt: { ...ts, 'x-nullable': true },
        } } }, limit: int, offset: int } } }, ...errors } }) },
      '/api/v1/faq': { get: op('ListFaq', 'Questions and answers', 'The knowledge base FAQ entries.', {
        responses: { 200: { description: 'OK', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id, question: str, answer: str, variants: { type: 'array', items: str }, audience: str, uses: int, updatedAt: ts } } } } } }, ...errors } }) },
      '/api/v1/tags': { get: op('ListTags', 'Tags', '', { responses: { 200: { description: 'OK', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id, name: str } } } } } }, ...errors } }) },
      '/api/v1/users': { get: op('ListUsers', 'Team members', 'Active people (id and name).', { responses: { 200: { description: 'OK', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id, name: str } } } } } }, ...errors } }) },
    },
  };
}
