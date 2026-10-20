const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_EMAIL = 'test-admin@bureau.local';
process.env.ADMIN_PASSWORD = 'TestAdminPassword!123';

const { app } = require('../server');

let server;
let baseUrl;

function request(path, options) {
  return fetch(`${baseUrl}${path}`, options);
}

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('health endpoint and security headers are available', async () => {
  const response = await request('/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'UP');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('anonymous admin access is protected', async () => {
  const apiResponse = await request('/api/payments');
  assert.equal(apiResponse.status, 401);

  const pageResponse = await request('/admin.html', { redirect: 'manual' });
  assert.equal(pageResponse.status, 302);
  assert.equal(pageResponse.headers.get('location'), '/account.html');

  const documentResponse = await request('/api/admin/documents');
  assert.equal(documentResponse.status, 401);
});

test('invalid public input is rejected before provider calls', async () => {
  const seekerResponse = await request('/api/job-seeker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: 'Test', email: 'invalid-email' })
  });
  assert.equal(seekerResponse.status, 400);

  const paymentResponse = await request('/api/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageName: '1 Hour', amount: 999999, phone: '0771234567' })
  });
  assert.equal(paymentResponse.status, 400);
});

test('admin login sets a secure session cookie and overview is protected', async () => {
  const loginResponse = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const overviewResponse = await request('/api/admin/records', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json();
  assert.equal(typeof overview.totals.jobs, 'number');
  assert.equal(typeof overview.totals.applications, 'number');
});
