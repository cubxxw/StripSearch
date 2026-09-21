import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestServer, TestClient } from './harness.js';
import { createFakeFactory } from './fakes.js';

test('signup, session persistence, wrong password and logout', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());

  const health = await server.client.json<{
    status: string;
    capabilities: { github: boolean; exa: boolean };
  }>('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.capabilities.github, true);
  const healthText = JSON.stringify(health.body);
  assert.equal(healthText.includes('EXA_API_KEY'), false);
  assert.equal(healthText.includes('secret'), false);

  const signup = await server.client.signUp('alice@example.test', 'password-1234', 'Alice');
  assert.equal(signup.status, 200);
  const setCookies = signup.headers.getSetCookie();
  assert.ok(setCookies.length > 0, 'signup must set a session cookie');
  const sessionCookie = setCookies.find((value) => value.startsWith('stripsearch.')) ?? setCookies[0] ?? '';
  assert.match(sessionCookie, /^stripsearch\./);
  assert.match(sessionCookie.toLowerCase(), /httponly/);
  assert.match(sessionCookie.toLowerCase(), /samesite=lax/);
  assert.doesNotMatch(sessionCookie.toLowerCase(), /secure/);

  const session = await server.client.json<{ user: { email: string } } | null>('/api/auth/get-session');
  assert.equal(session.status, 200);
  assert.equal(session.body?.user.email, 'alice@example.test');

  // Session survives a new request cycle with only the cookie.
  const persisted = await server.client.json<{ user: { email: string } }>('/api/auth/get-session');
  assert.equal(persisted.body.user.email, 'alice@example.test');

  // Wrong password must not create a session.
  const stranger = new TestClient(server.baseUrl, server.origin);
  const wrong = await stranger.signIn('alice@example.test', 'definitely-wrong');
  assert.notEqual(wrong.status, 200);
  const strangerSession = await stranger.json<unknown>('/api/auth/get-session');
  assert.equal(strangerSession.body, null);

  const logout = await server.client.signOut();
  assert.equal(logout.status, 200);
  const afterLogout = await server.client.json<unknown>('/api/auth/get-session');
  assert.equal(afterLogout.body, null);
});

test('signup input is restricted and oversized auth bodies are rejected', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());

  const emptyName = await server.client.request('/api/auth/sign-up/email', {
    method: 'POST',
    json: { name: '', email: 'b@example.test', password: 'password-1234' }
  });
  assert.equal(emptyName.status, 400);

  const longName = await server.client.request('/api/auth/sign-up/email', {
    method: 'POST',
    json: { name: 'x'.repeat(200), email: 'c@example.test', password: 'password-1234' }
  });
  assert.equal(longName.status, 400);

  const badEmail = await server.client.request('/api/auth/sign-up/email', {
    method: 'POST',
    json: { name: 'Valid', email: 'not-an-email', password: 'password-1234' }
  });
  assert.equal(badEmail.status, 400);

  const huge = await server.client.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ name: 'a'.repeat(20000), email: 'd@example.test', password: 'password-1234' })
  });
  assert.equal(huge.status, 413);
});

test('chunked oversized auth bodies are rejected by the bounded adapter', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());
  const payload = JSON.stringify({
    name: 'a'.repeat(20000),
    email: 'chunked@example.test',
    password: 'password-1234'
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    }
  });
  const response = await server.client.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream
  });
  assert.equal(response.status, 413);
});

test('session cookie is not exposed in a response body and health has no keys', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());
  const response = await server.client.signUp('d@example.test');
  const text = await response.text();
  assert.equal(text.includes('password'), false);
  assert.equal(text.includes(server.boot.config.authSecret), false);

  // The stored credential is a hash, never the plaintext password.
  const row = server.boot.db
    .prepare('SELECT password FROM account WHERE providerId = ?')
    .get('credential') as { password?: string } | undefined;
  assert.ok(row?.password);
  assert.notEqual(row.password, 'password-1234');
  assert.ok((row.password ?? '').length > 20);
});
