const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const database = require('../database');
const { app, applyPaymentResult } = require('../server');
const provider = require('../wifi-provider');

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('mock provisioning creates voucher credentials', async () => {
  const result = await provider.provision({
    referenceId: 'TEST-VOUCHER-123456',
    phone: '+256700000000',
    packageName: '1 Hour',
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 3600000).toISOString()
  });
  assert.equal(result.status, 'PROVISIONED');
  assert.match(result.payload.username, /^demo-/);
  assert.ok(result.payload.password);
});

test('successful payment creates one entitlement on duplicate results', async () => {
  const referenceId = `TEST-PAY-${Date.now()}`;
  const payment = {
    referenceId,
    externalId: `EXT-${referenceId}`,
    packageName: '1 Hour',
    amount: 200,
    phone: '+256700000000',
    currency: 'UGX',
    status: 'PENDING',
    callbackUrl: 'http://localhost/callback',
    createdAt: new Date().toISOString()
  };
  database.createPayment(payment);
  const payload = { referenceId, externalId: payment.externalId, status: 'SUCCESSFUL', transactionId: `TX-${referenceId}` };
  const first = await applyPaymentResult(payment, 'SUCCESSFUL', payload, `test:${referenceId}`);
  const second = await applyPaymentResult(database.getPayment(referenceId), 'SUCCESSFUL', payload, `test:${referenceId}`);
  assert.equal(first.applied, true);
  assert.equal(second.reason, 'duplicate-event');
  assert.equal(database.getWifiEntitlement(referenceId).access.username.startsWith('demo-'), true);

  const cleanup = new DatabaseSync('data/bureau-portal.sqlite');
  cleanup.prepare('DELETE FROM wifi_provisioning WHERE entitlement_id IN (SELECT id FROM wifi_entitlements WHERE reference_id = ?)').run(referenceId);
  cleanup.prepare('DELETE FROM wifi_entitlements WHERE reference_id = ?').run(referenceId);
  cleanup.prepare('DELETE FROM payment_events WHERE reference_id = ?').run(referenceId);
  cleanup.prepare('DELETE FROM payments WHERE reference_id = ?').run(referenceId);
  cleanup.close();
});

test('job application and matching workflow succeeds', async () => {
  const suffix = `test-${Date.now()}`;
  const post = (path, body, headers = {}) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const employerResponse = await post('/api/employer', { companyName: `Test Employer ${suffix}`, contactName: 'Test Owner', email: `${suffix}@employer.example`, phone: '0771234567', district: 'Kampala', hiringNeed: 'Node developer', companyType: 'Technology' });
  const seekerResponse = await post('/api/job-seeker', { fullName: `Test Seeker ${suffix}`, email: `${suffix}@seeker.example`, phone: '0777654321', district: 'Kampala', profession: 'Node developer', skills: 'Node JavaScript', availability: 'Immediate' });
  const employer = await employerResponse.json();
  const seeker = await seekerResponse.json();
  const employerAuth = { Authorization: `Bearer ${employer.employer.dashboardToken}` };
  const seekerAuth = { Authorization: `Bearer ${seeker.profile.dashboardToken}` };
  const jobResponse = await post('/api/jobs', { title: 'Node Developer', description: 'Build Node services', district: 'Kampala', skills: 'Node JavaScript', employmentType: 'Full-time' }, employerAuth);
  const job = await jobResponse.json();
  const applicationResponse = await post(`/api/jobs/${job.job.id}/applications`, { coverNote: 'Please consider my application.' }, seekerAuth);
  const dashboardResponse = await fetch(`${baseUrl}/api/dashboard/job-seeker`, { headers: seekerAuth });
  const dashboard = await dashboardResponse.json();
  assert.equal(jobResponse.status, 201);
  assert.equal(applicationResponse.status, 201);
  assert.ok(dashboard.matches.some((match) => match.job.id === job.job.id));

  const cleanup = new DatabaseSync('data/bureau-portal.sqlite');
  cleanup.prepare('DELETE FROM applications WHERE job_id = ?').run(job.job.id);
  cleanup.prepare('DELETE FROM matches WHERE job_id = ?').run(job.job.id);
  cleanup.prepare('DELETE FROM jobs WHERE id = ?').run(job.job.id);
  cleanup.prepare('DELETE FROM employers WHERE email = ?').run(employer.employer.email);
  cleanup.prepare('DELETE FROM job_seekers WHERE email = ?').run(seeker.profile.email);
  cleanup.close();
});
