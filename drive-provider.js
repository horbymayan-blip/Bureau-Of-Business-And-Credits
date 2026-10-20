const crypto = require('crypto');
const axios = require('axios');

let tokenCache = { value: null, expiresAt: 0 };

function configuration() {
  return {
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    privateKey: String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  };
}

function assertConfigured() {
  const config = configuration();
  if (!config.folderId || !config.clientEmail || !config.privateKey) {
    throw new Error('Google Drive requires GOOGLE_DRIVE_FOLDER_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.');
  }
  if (!config.privateKey.includes('BEGIN PRIVATE KEY')) throw new Error('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not a valid PEM key.');
  return config;
}

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
  const config = assertConfigured();
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claim = base64Url(JSON.stringify({
    iss: config.clientEmail,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const assertion = `${header}.${claim}.${base64Url(signer.sign(config.privateKey))}`;
  const response = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  tokenCache = { value: response.data.access_token, expiresAt: Date.now() + Number(response.data.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

async function upload({ name, mimeType, buffer }) {
  const config = assertConfigured();
  const token = await getAccessToken();
  const boundary = `bureau_${crypto.randomBytes(12).toString('hex')}`;
  const metadata = JSON.stringify({ name, mimeType, parents: [config.folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const response = await axios.post('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,createdTime', body, {
    timeout: 30000,
    maxContentLength: 12 * 1024 * 1024,
    maxBodyLength: 12 * 1024 * 1024,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': body.length }
  });
  return response.data;
}

async function link({ fileId }) {
  const config = assertConfigured();
  const token = await getAccessToken();
  const response = await axios.get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    params: { fields: 'id,name,mimeType,size,webViewLink,createdTime,parents', supportsAllDrives: true },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000
  });
  if (!response.data.parents?.includes(config.folderId)) throw new Error('The Google Drive file is not inside the configured private folder.');
  return response.data;
}

module.exports = { assertConfigured, link, upload };
