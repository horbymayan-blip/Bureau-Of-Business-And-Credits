const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'test-admin@bureau.local';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TestAdminPassword!123';

const { app, applyPaymentResult } = require('../server');
const database = require('../database');

let server;
let baseUrl;
const createdCodes = [];

function request(path, options) {
  return fetch(`${baseUrl}${path}`, options);
}

function post(path, body, headers = {}) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  const cleanup = new DatabaseSync('data/bureau-portal.sqlite');
  cleanup.prepare("DELETE FROM payment_events WHERE reference_id IN (SELECT reference_id FROM payments WHERE package_name LIKE 'Movies VIP%')").run();
  cleanup.prepare("DELETE FROM payments WHERE package_name LIKE 'Movies VIP%'").run();
  cleanup.prepare("DELETE FROM movie_entitlements WHERE reference_id LIKE 'TEST-MOV%' OR reference_id = 'TEST-EMAIL-ENT' OR phone = '+256700000099' OR phone = '+256700000097' OR email = 'guest.viewer@example.com'").run();
  for (const code of createdCodes) {
    cleanup.prepare('DELETE FROM vouchers WHERE code = ?').run(code);
  }
  cleanup.close();
});

test('premium checkout page is served with gateway tabs', async () => {
  const response = await request('/premium');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /gateway-tabs/);
  assert.match(html, /Airtel Money/);
  assert.match(html, /Voucher/);
  assert.match(html, /Free Ads/);
  assert.doesNotMatch(html, /login\.js/);
});

test('movie catalog routes premium titles to the payment section', async () => {
  const response = await request('/movies');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /data-access="premium"/);
  assert.match(html, /\/premium\?next=/);
  assert.match(html, /data-filter="premium"/);
});

test('player page gates premium titles behind the access API', async () => {
  const response = await request('/play.html?mId=74102');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /api\/movie-access/);
  assert.match(html, /access: 'premium'/);
});

test('subscription validates plan, gateway and identities before contacting a provider', async () => {
  const badPlan = await post('/api/movie-subscribe', { plan: 'century', gateway: 'mtn', accessPhone: '0771234567' });
  assert.equal(badPlan.status, 400);

  const badGateway = await post('/api/movie-subscribe', { plan: '1_day', gateway: 'paypal', accessPhone: '0771234567' });
  assert.equal(badGateway.status, 400);

  const missingIdentity = await post('/api/movie-subscribe', { plan: '1_day', gateway: 'mtn', payerPhone: '0771234567' });
  assert.equal(missingIdentity.status, 400);

  const badPayer = await post('/api/movie-subscribe', { plan: '1_day', gateway: 'mtn', accessPhone: '0771234567', payerPhone: 'not-a-number' });
  assert.equal(badPayer.status, 400);
});

test('successful movie payment activates the entitlement without provisioning wifi', async () => {
  const referenceId = `TEST-MOV-${Date.now()}`;
  const payment = {
    referenceId,
    externalId: `EXT-${referenceId}`,
    packageName: 'Movies VIP - 1 Day',
    amount: 1000,
    phone: '+256700000098',
    currency: 'UGX',
    status: 'PENDING',
    callbackUrl: 'http://localhost/callback',
    createdAt: new Date().toISOString()
  };
  database.createPayment(payment);
  const now = new Date().toISOString();
  database.createMovieEntitlement({ id: `MOV-${referenceId}`, referenceId, phone: '+256700000098', plan: '1_day', startsAt: now, endsAt: now });

  const payload = { referenceId, externalId: payment.externalId, status: 'SUCCESSFUL', transactionId: `TX-${referenceId}` };
  const first = await applyPaymentResult(payment, 'SUCCESSFUL', payload, `test:${referenceId}`);
  const second = await applyPaymentResult(database.getPayment(referenceId), 'SUCCESSFUL', payload, `test:${referenceId}`);

  assert.equal(first.applied, true);
  assert.equal(second.reason, 'duplicate-event');

  const entitlement = database.getMovieEntitlement(referenceId);
  assert.equal(entitlement.status, 'ACTIVE');
  assert.ok(new Date(entitlement.endsAt) > new Date());
  assert.equal(database.getWifiEntitlement(referenceId), null);

  const failRef = `TEST-MOV-FAIL-${Date.now()}`;
  database.createPayment({ ...payment, referenceId: failRef, externalId: `EXT-${failRef}` });
  database.createMovieEntitlement({ id: `MOV-${failRef}`, referenceId: failRef, phone: '+256700000098', plan: '1_day', startsAt: now, endsAt: now });
  await applyPaymentResult(database.getPayment(failRef), 'FAILED', { referenceId: failRef }, `test:${failRef}`);
  assert.equal(database.getMovieEntitlement(failRef).status, 'FAILED');
});

test('voucher redemption grants premium access exactly once', async () => {
  const login = await post('/api/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  const sessionCookie = login.headers.get('set-cookie').split(';')[0];

  const created = await post('/api/admin/vouchers', { plan: '1_week', quantity: 1 }, { Cookie: sessionCookie });
  assert.equal(created.status, 201);
  const { vouchers } = await created.json();
  assert.equal(vouchers.length, 1);
  createdCodes.push(vouchers[0]);

  const redeem = await post('/api/movie-vouchers/redeem', { code: vouchers[0], phone: '0700000099' });
  assert.equal(redeem.status, 200);
  const redeemBody = await redeem.json();
  assert.equal(redeemBody.access, true);
  assert.equal(redeemBody.plan, '1_week');

  const setCookie = redeem.headers.get('set-cookie');
  assert.match(setCookie, /bureau_movie_access=/);
  assert.match(setCookie, /HttpOnly/);

  const access = await request('/api/movie-access', { headers: { Cookie: setCookie.split(';')[0] } });
  const accessBody = await access.json();
  assert.equal(accessBody.access, true);
  assert.equal(accessBody.plan, '1_week');

  const again = await post('/api/movie-vouchers/redeem', { code: vouchers[0], phone: '0700000099' });
  assert.equal(again.status, 409);
});

test('ad-supported unlock grants temporary access and enforces the daily limit', async () => {
  const first = await post('/api/movie-ad-unlock', { phone: '0700000097' });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.access, true);
  assert.equal(body.plan, 'ad_unlock');

  const setCookie = first.headers.get('set-cookie');
  const access = await request('/api/movie-access', { headers: { Cookie: setCookie.split(';')[0] } });
  assert.equal((await access.json()).access, true);

  assert.equal((await post('/api/movie-ad-unlock', { phone: '0700000097' })).status, 200);
  assert.equal((await post('/api/movie-ad-unlock', { phone: '0700000097' })).status, 200);
  assert.equal((await post('/api/movie-ad-unlock', { phone: '0700000097' })).status, 429);
});

test('returning subscribers restore access with phone or email', async () => {
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  database.createMovieEntitlement({
    id: 'TEST-EMAIL-ENT',
    referenceId: 'TEST-EMAIL-ENT',
    phone: '',
    email: 'guest.viewer@example.com',
    plan: '1_day',
    status: 'ACTIVE',
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString()
  });

  const missing = await post('/api/movie-signin', { phone: '0700123456' });
  assert.equal(missing.status, 404);

  const ok = await post('/api/movie-signin', { email: 'guest.viewer@example.com' });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  const access = await request('/api/movie-access', { headers: { Cookie: setCookie.split(';')[0] } });
  assert.equal((await access.json()).access, true);
});

test('unknown payment reference returns 404', async () => {
  const response = await request('/api/movie-subscribe/does-not-exist');
  assert.equal(response.status, 404);
});
