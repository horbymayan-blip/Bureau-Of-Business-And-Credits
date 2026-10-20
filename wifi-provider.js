const axios = require('axios');

const mode = process.env.WIFI_PROVISIONING_MODE || 'mock';
const providerUrl = process.env.WIFI_PROVIDER_URL || '';
const providerToken = process.env.WIFI_PROVIDER_TOKEN || '';
const providerTimeoutMs = Number(process.env.WIFI_PROVIDER_TIMEOUT_MS || 10000);
const mikrotikUrl = process.env.MIKROTIK_URL || '';
const mikrotikUsername = process.env.MIKROTIK_USERNAME || '';
const mikrotikPassword = process.env.MIKROTIK_PASSWORD || '';
const mikrotikProfile = process.env.MIKROTIK_HOTSPOT_PROFILE || 'default';

const packageUptimes = {
  '1 Hour': '1h',
  '3 Hours': '3h',
  '2 Days': '2d',
  '7 Days': '7d',
  '30 Days': '30d'
};

function assertConfigured() {
  if (!providerUrl) throw new Error('WIFI_PROVIDER_URL is required for live Wi-Fi provisioning.');
  if (!/^https:\/\//i.test(providerUrl)) throw new Error('WIFI_PROVIDER_URL must use HTTPS.');
  if (!providerToken) throw new Error('WIFI_PROVIDER_TOKEN is required for live Wi-Fi provisioning.');
}

async function provision({ referenceId, phone, packageName, startsAt, endsAt }) {
  if (mode === 'mock') {
    const username = `demo-${referenceId.slice(0, 8).toLowerCase()}`;
    const password = require('crypto').randomBytes(6).toString('base64url');
    return {
      status: 'PROVISIONED',
      providerReference: `WIFI-${referenceId.slice(0, 12).toUpperCase()}`,
      payload: { mode: 'mock', phone, packageName, startsAt, endsAt, username, password, profile: 'demo' }
    };
  }

  if (mode === 'mikrotik-rest') {
    if (!mikrotikUrl || !/^https:\/\//i.test(mikrotikUrl)) throw new Error('MIKROTIK_URL must be an HTTPS RouterOS REST URL.');
    if (!mikrotikUsername || !mikrotikPassword) throw new Error('MIKROTIK_USERNAME and MIKROTIK_PASSWORD are required.');
    if (!packageUptimes[packageName]) throw new Error(`No MikroTik uptime mapping exists for ${packageName}.`);

    const username = `bp-${referenceId.slice(0, 12).toLowerCase()}`;
    const password = require('crypto').randomBytes(6).toString('base64url');
    const response = await axios.post(
      `${mikrotikUrl.replace(/\/$/, '')}/rest/ip/hotspot/user/add`,
      {
        name: username,
        password,
        profile: mikrotikProfile,
        'limit-uptime': packageUptimes[packageName],
        comment: `Bureau Portal ${referenceId} ${phone}`
      },
      {
        timeout: providerTimeoutMs,
        auth: { username: mikrotikUsername, password: mikrotikPassword },
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': referenceId }
      }
    );

    return {
      status: 'PROVISIONED',
      providerReference: response.data?.['.id'] || response.data?.id || username,
      payload: { provider: 'mikrotik-routeros', username, password, profile: mikrotikProfile, uptime: packageUptimes[packageName], response: response.data }
    };
  }

  if (mode !== 'http') throw new Error(`Unsupported WIFI_PROVISIONING_MODE: ${mode}`);
  assertConfigured();

  const response = await axios.post(
    providerUrl,
    { referenceId, phone, packageName, startsAt, endsAt },
    {
      timeout: providerTimeoutMs,
      headers: {
        Authorization: `Bearer ${providerToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': referenceId
      }
    }
  );

  return {
    status: 'PROVISIONED',
    providerReference: response.data?.id || response.data?.referenceId || referenceId,
    payload: response.data
  };
}

module.exports = { mode, provision };
