const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databaseFile = path.join(__dirname, '..', 'data', 'bureau-portal.sqlite');
process.env.NODE_ENV = 'production';
process.env.ADMIN_EMAIL = 'callback-test@bureau.local';
process.env.ADMIN_PASSWORD = 'CallbackTestPassword!123';
process.env.MOMO_ENVIRONMENT = 'sandbox';
process.env.MOMO_BASE_URL = 'https://sandbox.momodeveloper.mtn.com';
process.env.MOMO_CURRENCY = 'EUR';
process.env.MOMO_PRIMARY_KEY = 'test-primary-key';
process.env.MOMO_API_USER = 'test-api-user';
process.env.MOMO_API_KEY = 'test-api-key';
process.env.MOMO_CALLBACK_URL = 'https://example.com/api/payment/callback';
process.env.WIFI_PROVISIONING_MODE = 'mock';

const axios = require('axios');
const database = require('../database');
const { app } = require('../server');

const originalPost = axios.post;
const originalGet = axios.get;
const providerStatuses = new Map();
let server;
let baseUrl;

function cleanupTestPayments() {
  const cleanup = new DatabaseSync(databaseFile);
  cleanup.prepare('DELETE FROM wifi_provisioning WHERE entitlement_id IN (SELECT id FROM wifi_entitlements WHERE reference_id = ?)').run('callback-success');
  cleanup.prepare('DELETE FROM wifi_entitlements WHERE reference_id = ?').run('callback-success');
  cleanup.prepare('DELETE FROM payment_events WHERE reference_id IN (?, ?)').run('callback-success', 'callback-failure');
  cleanup.prepare('DELETE FROM payments WHERE reference_id IN (?, ?)').run('callback-success', 'callback-failure');
  cleanup.close();
}

test.before(async () => {
  axios.post = async (url) => {
    if (url.endsWith('/collection/token/')) {
      return { data: { access_token: 'test-access-token', expires_in: 3600 } };
    }
    throw new Error(`Unexpected MoMo POST: ${url}`);
  };
  axios.get = async (url) => {
    const referenceId = decodeURIComponent(url.split('/').pop());
    return { data: { status: providerStatuses.get(referenceId) || 'PENDING' } };
  };

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  cleanupTestPayments();

  axios.post = originalPost;
  axios.get = originalGet;
});

test('production Wi-Fi callbacks need no custom signature and use MTN status as authority', async () => {
  cleanupTestPayments();
  const payments = [
    { referenceId: 'callback-success', externalId: 'EXT-CALLBACK-SUCCESS', status: 'SUCCESSFUL' },
    { referenceId: 'callback-failure', externalId: 'EXT-CALLBACK-FAILURE', status: 'FAILED' }
  ];

  for (const payment of payments) {
    database.createPayment({
      ...payment,
      packageName: '1 Hour',
      amount: 200,
      phone: '256700000000',
      currency: 'EUR',
      callbackUrl: process.env.MOMO_CALLBACK_URL,
      createdAt: new Date().toISOString()
    });
    providerStatuses.set(payment.referenceId, payment.status);
  }

  for (const payment of payments) {
    const response = await fetch(`${baseUrl}/api/payment/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: { external_id: payment.externalId, status: payment.referenceId === 'callback-failure' ? 'SUCCESSFUL' : 'PENDING' }
      })
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.success, true);
    assert.equal(database.getPayment(payment.referenceId).status, payment.status);
  }

  assert.ok(database.getWifiEntitlement('callback-success').access);
  assert.equal(database.getWifiEntitlement('callback-failure'), null);
});
