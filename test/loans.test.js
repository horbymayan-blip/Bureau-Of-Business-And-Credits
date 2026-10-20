const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_EMAIL = 'test-admin@bureau.local';
process.env.ADMIN_PASSWORD = 'TestAdminPassword!123';

const { app } = require('../server');
const database = require('../database');

let server;
let baseUrl;

function post(path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('loan products expose quotes', async () => {
  const products = await (await fetch(`${baseUrl}/api/loans/products`)).json();
  assert.equal(products.success, true);
  assert.ok(products.products.length >= 5);
  const quote = await (await post('/api/loans/quote', { product: 'Business Loan', amount: 1000000, termMonths: 6 })).json();
  assert.equal(quote.quote.monthly, Math.round((1000000 + 1000000 * 0.05 * 6) / 6));
});

test('loan application validates, tracks, and admin can decide', async () => {
  const bad = await post('/api/loans/apply', { fullName: 'Test', email: 'bad', phone: '0771234567' });
  assert.equal(bad.status, 400);

  const suffix = Date.now();
  const good = await post('/api/loans/apply', {
    fullName: 'Loan Tester', email: `loan${suffix}@example.com`, phone: '0771234567',
    district: 'Kampala', product: 'Business Loan', amount: 500000, termMonths: 6,
    purpose: 'Restock shop', monthlyIncome: 1500000, employmentStatus: 'Business owner'
  });
  assert.equal(good.status, 201);
  const created = await good.json();

  const tracked = await (await fetch(`${baseUrl}/api/loans/track?phone=0771234567`)).json();
  assert.ok(tracked.applications.some((a) => a.id === created.application.id));

  const login = await post('/api/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const decided = await fetch(`${baseUrl}/api/admin/loans/${created.application.id}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ status: 'APPROVED', decisionNote: 'Looks good' })
  });
  assert.equal(decided.status, 200);
  assert.equal(database.getLoanApplication(created.application.id).status, 'APPROVED');
});
