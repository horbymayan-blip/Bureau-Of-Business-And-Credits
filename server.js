const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const database = require('./database');
const wifiProvider = require('./wifi-provider');
const driveProvider = require('./drive-provider');
const { createSessionToken, hashPassword, verifyPassword } = require('./auth');

dotenv.config();

const paymentProviders = require('./payment-providers');

const app = express();
const PORT = process.env.PORT || 3000;
const tokenCache = { value: null, expiresAt: 0 };
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function logEvent(event, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

function notify(recipient, event, message) {
  const channel = process.env.NOTIFICATION_CHANNEL || 'log';
  database.queueNotification({ recipient, channel, event, message });
  logEvent('notification.queued', { recipient, channel, event });
}

const MOMO_BASE_URL = String(process.env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com').replace(/\/+$/, '');
const MOMO_ENVIRONMENT = process.env.MOMO_ENVIRONMENT || 'sandbox';
const MOMO_CURRENCY = process.env.MOMO_CURRENCY || (String(process.env.MOMO_BASE_URL || 'sandbox').includes('sandbox') ? 'EUR' : 'UGX');
const MOMO_PRIMARY_KEY = process.env.MOMO_PRIMARY_KEY;
const MOMO_API_USER = process.env.MOMO_API_USER;
const MOMO_API_KEY = process.env.MOMO_API_KEY;
const MOMO_CALLBACK_URL = process.env.MOMO_CALLBACK_URL || 'http://localhost:3000/api/payment/callback';
const RAW_CALLBACK_SECRET = process.env.MOMO_CALLBACK_SECRET || '';
// Treat example placeholder values as "not configured" so sandbox callbacks are not rejected.
const MOMO_CALLBACK_SECRET = /replace-with|example|changeme|placeholder/i.test(RAW_CALLBACK_SECRET) ? '' : RAW_CALLBACK_SECRET;
const PAYMENT_STATUSES = new Set(['PENDING', 'SUCCESSFUL', 'FAILED', 'REJECTED', 'TIMEOUT', 'CANCELLED']);
const WIFI_PACKAGES = new Map([
  ['1 Hour', 200],
  ['3 Hours', 600],
  ['2 Days', 1000],
  ['7 Days', 5000],
  ['30 Days', 20000]
]);
const AIRTIME_PACKAGES = new Map([
  ['Airtime 500', 500],
  ['Airtime 1000', 1000],
  ['Airtime 2000', 2000],
  ['Airtime 5000', 5000],
  ['Airtime 10000', 10000]
]);
const MOVIE_PACKAGE_PREFIX = 'Movies VIP - ';
const MOVIE_PLANS = new Map([
  ['1_day', { label: '1 Day', amount: 1000, durationMs: 24 * 60 * 60 * 1000 }],
  ['1_week', { label: '1 Week', amount: 5000, durationMs: 7 * 24 * 60 * 60 * 1000 }],
  ['1_month', { label: '1 Month', amount: 15000, durationMs: 30 * 24 * 60 * 60 * 1000 }]
]);
const MOVIE_ACCESS_COOKIE = 'bureau_movie_access';
const PAYMENT_FAILURE_STATUSES = new Set(['FAILED', 'REJECTED', 'TIMEOUT', 'CANCELLED']);
const VALID_PHONE_PATTERN = /^(?:\+256|256|0)?[0-9]{9,10}$/;
const SUPPORTED_MOVIE_GATEWAYS = new Set(['mtn', 'airtel', 'card']);
const AD_UNLOCK_DURATION_MS = 6 * 60 * 60 * 1000;
const AD_UNLOCK_DAILY_LIMIT = 3;
const VOUCHER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanText(value, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength);
}

function isValidEmail(value) {
  return EMAIL_PATTERN.test(cleanText(value, 254));
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function tokenize(value) {
  return new Set(cleanText(value, 2000).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
}

function scoreCandidate(job, seeker) {
  const jobTerms = new Set([...tokenize(job.skills), ...tokenize(job.title), ...tokenize(job.description)]);
  const seekerTerms = new Set([...tokenize(seeker.skills), ...tokenize(seeker.profession)]);
  const shared = [...seekerTerms].filter((term) => jobTerms.has(term));
  const reasons = shared.length ? [`Shared skills: ${shared.slice(0, 5).join(', ')}`] : [];
  if (job.district.toLowerCase() === seeker.district.toLowerCase()) reasons.push('Same district');
  if (job.district.toLowerCase() === seeker.district.toLowerCase()) shared.push('__district__');
  const score = Math.min(100, Math.round((shared.length / Math.max(1, seekerTerms.size)) * 80) + (reasons.includes('Same district') ? 20 : 0));
  return { score, reasons };
}

function requireProfile(req, type) {
  const token = getBearerToken(req);
  const accountRole = type === 'job-seeker' ? 'job-seeker' : 'employer';
  const accountSession = requireAccount(req, accountRole);
  if (accountSession) {
    return type === 'job-seeker'
      ? database.getJobSeekerById(accountSession.profileId)
      : database.getEmployerById(accountSession.profileId);
  }
  const profile = type === 'job-seeker'
    ? database.getJobSeekerByToken(token)
    : database.getEmployerByToken(token);
  return profile || null;
}

function getSessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie).bureau_session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return session;
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator === -1) return cookies;
    const key = part.slice(0, separator).trim();
    cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
    return cookies;
  }, {});
}

function setMovieAccessCookie(res, phone, endsAt) {
  const maxAge = Math.max(60, Math.floor((new Date(endsAt).getTime() - Date.now()) / 1000));
  res.setHeader(
    'Set-Cookie',
    `${MOVIE_ACCESS_COOKIE}=${encodeURIComponent(phone)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
  );
}

function parseMultipartBody(buffer, contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error('Multipart boundary is missing.');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(boundary, cursor);
    if (start === -1) break;
    const contentStart = start + boundary.length + 2;
    const next = buffer.indexOf(boundary, contentStart);
    if (next === -1) break;
    const part = buffer.subarray(contentStart, next - 2);
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator !== -1) {
      const headers = part.subarray(0, separator).toString('utf8');
      const content = part.subarray(separator + 4);
      const disposition = headers.match(/Content-Disposition: form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
      if (disposition) parts.push({ name: disposition[1], filename: disposition[2] || '', headers, content });
    }
    cursor = next;
  }
  return parts;
}

function requireAdmin(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session || session.role !== 'admin') {
    return res.status(401).json({ success: false, message: 'Admin authentication required.' });
  }
  req.user = session;
  return next();
}

function requireAdminPage(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session || session.role !== 'admin') return res.redirect('/account.html');
  return next();
}

function requireAccount(req, role) {
  const session = getSessionFromRequest(req);
  return session && session.role === role ? session : null;
}

function createAccountForProfile({ email, password, role, profileId, phone }) {
  if (!password) return null;
  if (password.length < 12) throw new Error('Password must be at least 12 characters.');
  const verificationToken = createSessionToken();
  database.createAccount({ email, passwordHash: hashPassword(password), role, profileId, phone, verificationToken });
  logEvent('account.created', { email, role, profileId });
  notify(email, 'account.verification.email', `Verify your Bureau Portal account with token ${verificationToken}.`);
  if (phone) notify(phone, 'account.verification.phone', `Your Bureau Portal verification token is ${verificationToken}.`);
  return verificationToken;
}

function seedAdminUser() {
  const configuredEmail = cleanText(process.env.ADMIN_EMAIL, 254).toLowerCase();
  const configuredPassword = String(process.env.ADMIN_PASSWORD || '');
  if (database.hasUsers()) {
    if (configuredEmail && configuredPassword.length >= 12) {
      database.updateAdminPassword({ email: configuredEmail, passwordHash: hashPassword(configuredPassword) });
        logEvent('admin.account.ready', { email: configuredEmail });
    }
    return;
  }

  const email = configuredEmail || 'admin@bureau.local';
  const password = configuredPassword.length >= 12 ? configuredPassword : `${uuidv4()}Bureau!`;
  database.createUser({ email, passwordHash: hashPassword(password) });
  logEvent('admin.account.created', { email, passwordGenerated: !configuredPassword });
}

function validateProductionConfiguration() {
  if (process.env.NODE_ENV !== 'production') return;
  const required = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'MOMO_PRIMARY_KEY', 'MOMO_API_USER', 'MOMO_API_KEY', 'MOMO_CALLBACK_SECRET'];
  const missing = required.filter((name) => !process.env[name] || /replace-with|example|changeme|placeholder/i.test(String(process.env[name])));
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  if (!/^https:\/\//i.test(MOMO_CALLBACK_URL)) throw new Error('MOMO_CALLBACK_URL must use HTTPS in production.');
}

validateProductionConfiguration();
seedAdminUser();

// Development-only check: verify MoMo credentials are usable against the sandbox API.
if (process.env.NODE_ENV !== 'production') {
  const required = ['MOMO_PRIMARY_KEY', 'MOMO_API_USER', 'MOMO_API_KEY'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error('WARNING: Missing MoMo credentials (sandbox mode):', missing.join(', '));
  }
}

function momoErrorDetail(error) {
  const status = error.response?.status;
  const data = error.response?.data;
  const detail = typeof data === 'string' ? data.slice(0, 300) : (data ? JSON.stringify(data).slice(0, 300) : '');
  const code = error.code || null;
  if (status === 401 || status === 403) {
    return {
      message: 'MoMo rejected your API user/key or subscription key. Re-provision the API user (POST /api/momo/provision) or check MTN dashboard approval.',
      status, code, detail
    };
  }
  if (status === 404) return { message: 'MoMo endpoint not found — check MOMO_BASE_URL.', status, code, detail };
  if (status === 400 && /currency/i.test(detail)) {
    return { message: `MoMo rejected the currency. Sandbox subscriptions usually require EUR; set MOMO_CURRENCY=EUR. (${detail})`, status, code, detail };
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return { message: 'Cannot reach MTN MoMo servers — check network/firewall or MOMO_BASE_URL.', status: status || null, code, detail };
  }
  return { message: detail || error.message || 'MoMo request failed.', status: status || null, code, detail };
}

function normalizeMsisdn(phone) {
  // MTN Collection API expects MSISDN without "+" (e.g. 256772123456).
  const digits = String(phone || '').replace(/[^0-9]/g, '');

  if (!digits) return '';
  if (digits.startsWith('256')) return digits;
  if (digits.startsWith('0')) return `256${digits.slice(1)}`;
  // Local 9-digit numbers starting with 7 (e.g. 772123456)
  if (/^7\d{8}$/.test(digits)) return `256${digits}`;

  return digits;
}

function getAuthHeader() {
  return `Basic ${Buffer.from(`${MOMO_API_USER}:${MOMO_API_KEY}`).toString('base64')}`;
}

async function getMoMoAccessToken() {
  if (Date.now() < tokenCache.expiresAt - 30000 && tokenCache.value) {
    return tokenCache.value;
  }

  if (!MOMO_PRIMARY_KEY || !MOMO_API_USER || !MOMO_API_KEY) {
    throw new Error('MoMo credentials are not configured (MOMO_PRIMARY_KEY, MOMO_API_USER, MOMO_API_KEY).');
  }

  try {
    const response = await axios.post(
      `${MOMO_BASE_URL}/collection/token/`,
      null,
      {
        timeout: 15000,
        headers: {
          Authorization: getAuthHeader(),
          'Ocp-Apim-Subscription-Key': MOMO_PRIMARY_KEY
        }
      }
    );

    const rawTokenPayload = Buffer.isBuffer(response.data)
      ? response.data.toString('utf8')
      : response.data;
    let tokenPayload = rawTokenPayload;

    if (typeof rawTokenPayload === 'string') {
      try {
        tokenPayload = JSON.parse(rawTokenPayload);
      } catch {
        tokenPayload = { access_token: rawTokenPayload };
      }
    }

    const accessToken = typeof tokenPayload === 'string'
      ? tokenPayload
      : tokenPayload.access_token;
    const expiresInSeconds = Number(tokenPayload.expires_in || 3600);

    if (!accessToken) {
      throw new Error('MoMo token response did not include an access token.');
    }

    tokenCache.value = accessToken;
    tokenCache.expiresAt = Date.now() + expiresInSeconds * 1000;

    return accessToken;
  } catch (error) {
    tokenCache.value = null;
    tokenCache.expiresAt = 0;
    const detail = momoErrorDetail(error);
    const wrapped = new Error(detail.message);
    wrapped.cause = error;
    wrapped.providerStatus = detail.status;
    wrapped.providerDetail = detail.detail;
    wrapped.code = detail.code;
    throw wrapped;
  }
}

async function requestToPay({ amount, phone, packageName, referenceId, externalId, payerMessage }) {
  const accessToken = await getMoMoAccessToken();
  const msisdn = normalizeMsisdn(phone);

  const response = await axios.post(
    `${MOMO_BASE_URL}/collection/v1_0/requesttopay`,
    {
      amount: String(amount),
      currency: MOMO_CURRENCY,
      externalId,
      payer: { partyIdType: 'MSISDN', partyId: msisdn },
      payerMessage: payerMessage || `Bureau Wi-Fi payment for ${packageName}`,
      payeeNote: `Payment for ${packageName}`
    },
    {
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Reference-Id': referenceId,
        'X-Target-Environment': MOMO_ENVIRONMENT,
        'X-Callback-Url': MOMO_CALLBACK_URL,
        'Ocp-Apim-Subscription-Key': MOMO_PRIMARY_KEY,
        'Content-Type': 'application/json'
      }
    }
  );

  return response;
}

async function getPaymentStatus(referenceId) {
  const accessToken = await getMoMoAccessToken();

  const response = await axios.get(
    `${MOMO_BASE_URL}/collection/v1_0/requesttopay/${referenceId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Target-Environment': MOMO_ENVIRONMENT,
        'Ocp-Apim-Subscription-Key': MOMO_PRIMARY_KEY
      }
    }
  );

  return response.data;
}

function canTransitionPayment(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) return true;
  if (currentStatus !== 'PENDING') return false;
  return PAYMENT_STATUSES.has(nextStatus);
}

function getPackageDurationMs(packageName) {
  const durations = { '1 Hour': 60, '3 Hours': 180, '2 Days': 2880, '7 Days': 10080, '30 Days': 43200 };
  return (durations[packageName] || 0) * 60 * 1000;
}

function isAirtimePackage(packageName) {
  return String(packageName || '').startsWith('Airtime ');
}

function getMoviePlanForPackage(packageName) {
  if (!String(packageName || '').startsWith(MOVIE_PACKAGE_PREFIX)) return null;
  const label = String(packageName).slice(MOVIE_PACKAGE_PREFIX.length);
  for (const [key, plan] of MOVIE_PLANS) {
    if (plan.label === label) return { key, ...plan };
  }
  return null;
}

function applyMoviePaymentResult(payment, normalizedStatus) {
  const plan = getMoviePlanForPackage(payment.packageName);
  const entitlement = database.getMovieEntitlement(payment.referenceId);
  if (!plan || !entitlement) return;

  if (normalizedStatus === 'SUCCESSFUL' && entitlement.status !== 'ACTIVE') {
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + plan.durationMs);
    const updated = database.updateMovieEntitlement(payment.referenceId, {
      status: 'ACTIVE',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString()
    });
    const identity = updated.phone || updated.email || payment.phone;
    notify(identity, 'movie.subscription.active', `Your Bureau Movies ${plan.label} VIP access is active until ${endsAt.toISOString()}.`);
    if (updated.email && updated.email !== identity) {
      notify(updated.email, 'movie.subscription.active', `Your Bureau Movies ${plan.label} VIP access is active until ${endsAt.toISOString()}.`);
    }
  } else if (PAYMENT_FAILURE_STATUSES.has(normalizedStatus) && entitlement.status === 'PENDING') {
    database.updateMovieEntitlement(payment.referenceId, { status: normalizedStatus });
    const identity = entitlement.phone || entitlement.email || payment.phone;
    notify(identity, 'movie.subscription.failed', `Your Bureau Movies payment ${payment.referenceId} was ${normalizedStatus.toLowerCase()}.`);
  }
}

async function provisionWifi(entitlement, payment) {
  try {
    const result = await wifiProvider.provision({
      referenceId: payment.referenceId,
      phone: payment.phone,
      packageName: payment.packageName,
      startsAt: entitlement.starts_at,
      endsAt: entitlement.ends_at
    });
    database.recordProvisioningAttempt(entitlement.id, result);
    return result;
  } catch (error) {
    database.recordProvisioningAttempt(entitlement.id, {
      status: 'FAILED',
      errorMessage: error.response?.data?.message || error.message
    });
    console.error('Wi-Fi provisioning failed:', error.message);
    return { status: 'FAILED' };
  }
}

function isLoanRepaymentPackage(packageName) {
  return String(packageName || '').startsWith('Loan Repayment - ');
}

async function applyPaymentResult(payment, status, payload, eventKey) {
  const normalizedStatus = String(status || '').toUpperCase();
  if (!PAYMENT_STATUSES.has(normalizedStatus) || !canTransitionPayment(payment.status, normalizedStatus)) {
    return { applied: false, reason: 'invalid-status-transition' };
  }

  if (!database.recordPaymentEvent({ referenceId: payment.referenceId, eventKey, status: normalizedStatus, payload })) {
    return { applied: false, reason: 'duplicate-event', payment };
  }

  const updatedPayment = database.updatePayment(payment.referenceId, {
    ...payment,
    status: normalizedStatus,
    providerPayload: payload,
    checkedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  if (getMoviePlanForPackage(payment.packageName)) {
    applyMoviePaymentResult(payment, normalizedStatus);
    return { applied: true, payment: updatedPayment };
  }

  if (isLoanRepaymentPackage(payment.packageName)) {
    if (normalizedStatus === 'SUCCESSFUL') {
      database.updateLoanRepaymentStatus(payment.referenceId, 'SUCCESSFUL');
      notify(payment.phone, 'loan.repayment.success', `Repayment of UGX ${Number(payment.amount).toLocaleString()} received for ${payment.packageName}.`);
    } else if (PAYMENT_FAILURE_STATUSES.has(normalizedStatus)) {
      database.updateLoanRepaymentStatus(payment.referenceId, normalizedStatus);
    }
    return { applied: true, payment: updatedPayment };
  }

  if (isAirtimePackage(payment.packageName)) {
    if (normalizedStatus === 'SUCCESSFUL') {
      notify(payment.phone, 'payment.success', `Payment approved for ${payment.packageName}. Airtime delivery will be confirmed by SMS.`);
    }
    return { applied: true, payment: updatedPayment };
  }

  const existingEntitlement = database.getWifiEntitlement(payment.referenceId);
  if (normalizedStatus === 'SUCCESSFUL' && (!existingEntitlement || !existingEntitlement.access)) {
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + getPackageDurationMs(payment.packageName));
    const entitlement = database.createWifiEntitlement({
      id: `WIFI-${uuidv4()}`,
      referenceId: payment.referenceId,
      phone: payment.phone,
      packageName: payment.packageName,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString()
    });
    await provisionWifi(entitlement, payment);
    notify(payment.phone, 'payment.success', `Payment approved for ${payment.packageName}.`);
    notify(payment.phone, 'voucher.ready', 'Your Wi-Fi voucher is ready.');
  }

  return { applied: true, payment: updatedPayment };
}

function verifyCallbackSignature(req) {
  if (!MOMO_CALLBACK_SECRET) return process.env.NODE_ENV !== 'production';
  const received = String(req.headers['x-momo-signature'] || req.headers['x-callback-signature'] || '');
  if (!received) return false;
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', MOMO_CALLBACK_SECRET).update(rawBody || '').digest('hex');
  return received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean) } : { origin: true }));
app.use((req, res, next) => {
  // Same-origin portal + API: allow credentials so wifi.html polling works.
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({
  limit: '32kb',
  verify: (req, res, buffer) => {
    if (req.path === '/api/payment/callback') req.rawBody = buffer;
  }
}));
app.use(express.urlencoded({ extended: true }));

const allowedDocumentTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
app.get('/api/admin/documents', requireAdmin, (req, res) => res.json({ success: true, documents: database.listDocuments() }));

app.post('/api/admin/documents/upload', requireAdmin, express.raw({ type: /^multipart\/form-data/i, limit: '10mb' }), async (req, res) => {
  try {
    const parts = parseMultipartBody(req.body, req.headers['content-type']);
    const file = parts.find((part) => part.filename);
    const profileId = parts.find((part) => part.name === 'relatedProfileId')?.content.toString('utf8').trim() || null;
    const profileType = parts.find((part) => part.name === 'relatedProfileType')?.content.toString('utf8').trim() || null;
    if (!file || !file.filename) return res.status(400).json({ success: false, message: 'A document file is required.' });
    const mimeType = file.headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream';
    if (!allowedDocumentTypes.has(mimeType)) return res.status(400).json({ success: false, message: 'Only PDF, Word, JPG, and PNG files are allowed.' });
    if (!file.content.length || file.content.length > 10 * 1024 * 1024) return res.status(400).json({ success: false, message: 'Documents must be smaller than 10 MB.' });
    const uploaded = await driveProvider.upload({ name: file.filename.replace(/[^a-zA-Z0-9._ -]/g, '_'), mimeType, buffer: file.content });
    database.createDocument({ driveFileId: uploaded.id, name: uploaded.name, mimeType: uploaded.mimeType, size: uploaded.size, webViewLink: uploaded.webViewLink, relatedProfileId: profileId, relatedProfileType: profileType });
    logEvent('document.uploaded', { driveFileId: uploaded.id, name: uploaded.name, relatedProfileId: profileId });
    return res.status(201).json({ success: true, document: uploaded });
  } catch (error) {
    logEvent('document.upload.failed', { message: error.message });
    return res.status(502).json({ success: false, message: 'Document upload is unavailable until Google Drive is configured.' });
  }
});

app.post('/api/admin/documents/link', requireAdmin, async (req, res) => {
  try {
    const file = await driveProvider.link({ fileId: cleanText(req.body?.driveFileId, 200) });
    database.createDocument({ driveFileId: file.id, name: file.name, mimeType: file.mimeType, size: file.size, webViewLink: file.webViewLink, relatedProfileId: cleanText(req.body?.relatedProfileId, 120) || null, relatedProfileType: cleanText(req.body?.relatedProfileType, 40) || null });
    return res.status(201).json({ success: true, document: file });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

const MOVIE_UPLOAD_DIR = path.join(__dirname, 'public', 'assets', 'movies');
fs.mkdirSync(MOVIE_UPLOAD_DIR, { recursive: true });

app.post('/api/admin/movies/media', requireAdmin, express.raw({ type: 'application/octet-stream', limit: '2gb' }), (req, res) => {
  try {
    const type = cleanText(req.query?.type, 40);
    if (!['media', 'poster', 'subtitle'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid media type. Use media, poster, or subtitle.' });
    }
    const filename = cleanText(req.headers['x-movie-filename'], 200);
    if (!filename) return res.status(400).json({ success: false, message: 'X-Movie-Filename header is required.' });
    if (!req.body || !req.body.length) {
      return res.status(400).json({ success: false, message: 'The uploaded file is empty. Choose a file with content and try again.' });
    }

    const allowedExtensions = {
      media: new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v', '.mkv']),
      poster: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']),
      subtitle: new Set(['.vtt', '.srt'])
    };
    const extension = path.extname(filename).toLowerCase();
    if (!allowedExtensions[type].has(extension)) {
      return res.status(400).json({ success: false, message: `That file type (${extension || 'unknown'}) is not supported for ${type}.` });
    }

    let safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
    if (!safeName || safeName === '.' || safeName === '..') safeName = `movie-${Date.now()}${extension}`;
    // Prevent path traversal: keep only the final path segment.
    safeName = path.basename(safeName);
    let targetPath = path.join(MOVIE_UPLOAD_DIR, safeName);
    if (!targetPath.startsWith(MOVIE_UPLOAD_DIR)) {
      return res.status(400).json({ success: false, message: 'Invalid filename.' });
    }
    // Avoid overwriting an existing asset: append a counter when needed.
    if (fs.existsSync(targetPath)) {
      const base = path.basename(safeName, extension) || 'movie';
      let counter = 1;
      do {
        safeName = `${base}-${counter}${extension}`;
        targetPath = path.join(MOVIE_UPLOAD_DIR, safeName);
        counter += 1;
      } while (fs.existsSync(targetPath) && counter < 1000);
    }
    fs.writeFileSync(targetPath, req.body);

    const assetUrl = `/assets/movies/${encodeURIComponent(safeName)}`;
    logEvent('movie.media.uploaded', { type, filename: safeName, size: req.body.length });
    return res.status(201).json({ success: true, assetUrl, filename: safeName, size: req.body.length });
  } catch (error) {
    logEvent('movie.media.upload.failed', { message: error.message });
    if (error && (error.code === 'ENOSPC' || /no space left|disk quota|ENOSPC/i.test(String(error.message || '')))) {
      return res.status(507).json({ success: false, message: 'Upload folder is out of disk space. Free space in OneDrive / public/assets/movies or upload a smaller file.' });
    }
    return res.status(502).json({ success: false, message: 'Media upload failed.' });
  }
});

app.get('/api/admin/movies', requireAdmin, (req, res) => {
  const movies = database.listMovies();
  return res.status(200).json({ success: true, movies });
});

app.get('/api/admin/movies/storage', requireAdmin, (req, res) => {
  try {
    let totalBytes = 0;
    let fileCount = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(MOVIE_UPLOAD_DIR, { withFileTypes: true });
    } catch (error) {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const stats = fs.statSync(path.join(MOVIE_UPLOAD_DIR, entry.name));
        totalBytes += Number(stats.size || 0);
        fileCount += 1;
      } catch (error) { /* ignore unreadable entry */ }
    }
    return res.status(200).json({
      success: true,
      uploadDir: 'public/assets/movies',
      fileCount,
      totalBytes,
      totalMb: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
      warning: 'Uploads live inside OneDrive — keep 2x the video size free or move big files out of sync.'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not read upload storage.' });
  }
});

app.post('/api/admin/movies', requireAdmin, (req, res) => {
  try {
    const payload = req.body || {};
    const license = payload.license || {};
    const normalized = {
      id: payload.id || `MOV-${uuidv4()}`,
      title: cleanText(payload.title, 120),
      year: Number(payload.year),
      runtime: cleanText(payload.runtime, 30),
      description: cleanText(payload.description, 1000),
      genres: Array.isArray(payload.genres) ? payload.genres.join(', ') : String(payload.genres || ''),
      mediaUrl: cleanText(payload.mediaUrl, 500),
      licenseName: cleanText(payload.licenseName || license.name, 160) || 'Bureau Portal Original',
      licenseUrl: cleanText(payload.licenseUrl || license.url, 200) || 'https://bureau.local/license',
      attribution: cleanText(payload.attribution || license.attribution, 500) || `${cleanText(payload.title, 120) || 'Bureau Portal'} — licensed for Bureau Movies streaming.`
    };
    const required = ['title', 'runtime', 'description', 'genres', 'mediaUrl'];
    for (const field of required) {
      if (!normalized[field]) return res.status(400).json({ success: false, message: `${field} is required.` });
    }
    if (!Number.isInteger(normalized.year) || normalized.year < 1888 || normalized.year > new Date().getFullYear() + 5) {
      return res.status(400).json({ success: false, message: 'Enter a valid release year.' });
    }
    const movie = database.createMovie({
      id: String(normalized.id),
      title: cleanText(normalized.title, 120),
      year: Number(normalized.year),
      runtime: cleanText(normalized.runtime, 30),
      description: cleanText(normalized.description, 1000),
      genres: String(normalized.genres || '').split(',').map((g) => g.trim()).filter(Boolean).join(', ') || 'General',
      access: ['free', 'premium'].includes(payload.access) ? payload.access : 'free',
      status: ['published', 'draft'].includes(payload.status) ? payload.status : 'published',
      featured: payload.featured === 'yes' || payload.featured === true,
      subtitlesLanguage: cleanText(payload.subtitlesLanguage, 12) || 'en',
      mediaUrl: normalized.mediaUrl,
      posterUrl: cleanText(payload.posterUrl, 500) || null,
      subtitlesUrl: payload.subtitlesUrl || null,
      license: {
        name: cleanText(normalized.licenseName, 160),
        url: cleanText(normalized.licenseUrl, 200),
        attribution: cleanText(normalized.attribution, 500)
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    logEvent('movie.created', { movieId: movie.id, title: movie.title });
    return res.status(201).json({ success: true, movie });
  } catch (error) {
    logEvent('movie.create.failed', { message: error.message });
    return res.status(400).json({ success: false, message: error.message || 'Failed to create movie.' });
  }
});

app.patch('/api/admin/movies/:movieId', requireAdmin, (req, res) => {
  try {
    const movieId = String(req.params.movieId);
    const existing = database.getMovie(movieId);
    if (!existing) return res.status(404).json({ success: false, message: 'Movie not found.' });
    
    const updates = {};
    const licenseBody = req.body.license || {};
    if (req.body.title !== undefined) updates.title = cleanText(req.body.title, 120);
    if (req.body.year !== undefined) updates.year = Number(req.body.year);
    if (req.body.runtime !== undefined) updates.runtime = cleanText(req.body.runtime, 30);
    if (req.body.description !== undefined) updates.description = cleanText(req.body.description, 1000);
    if (req.body.genres !== undefined) updates.genres = (Array.isArray(req.body.genres) ? req.body.genres.join(', ') : String(req.body.genres || '')).split(',').map((g) => g.trim()).filter(Boolean).join(', ');
    if (req.body.access !== undefined) updates.access = ['free', 'premium'].includes(req.body.access) ? req.body.access : existing.access;
    if (req.body.status !== undefined) updates.status = ['published', 'draft'].includes(req.body.status) ? req.body.status : existing.status;
    if (req.body.featured !== undefined) updates.featured = req.body.featured === 'yes' || req.body.featured === true;
    if (req.body.subtitlesLanguage !== undefined) updates.subtitlesLanguage = cleanText(req.body.subtitlesLanguage, 12) || 'en';
    if (req.body.mediaUrl) updates.mediaUrl = cleanText(req.body.mediaUrl, 500);
    if (req.body.posterUrl !== undefined) updates.posterUrl = cleanText(req.body.posterUrl, 500) || null;
    if (req.body.subtitlesUrl) updates.subtitlesUrl = req.body.subtitlesUrl;
    if (req.body.licenseName !== undefined || req.body.licenseUrl !== undefined || req.body.attribution !== undefined || licenseBody.name !== undefined || licenseBody.url !== undefined || licenseBody.attribution !== undefined) {
      updates.license = {
        name: cleanText(req.body.licenseName || licenseBody.name, 160) || existing.license?.name || '',
        url: cleanText(req.body.licenseUrl || licenseBody.url, 200) || existing.license?.url || '',
        attribution: cleanText(req.body.attribution || licenseBody.attribution, 500) || existing.license?.attribution || ''
      };
    }
    
    const movie = database.updateMovie(movieId, updates);
    logEvent('movie.updated', { movieId, title: movie.title });
    return res.status(200).json({ success: true, movie });
  } catch (error) {
    logEvent('movie.update.failed', { message: error.message });
    return res.status(400).json({ success: false, message: error.message || 'Failed to update movie.' });
  }
});

app.delete('/api/admin/movies/:movieId', requireAdmin, (req, res) => {
  try {
    const movieId = String(req.params.movieId);
    const existing = database.getMovie(movieId);
    if (!existing) return res.status(404).json({ success: false, message: 'Movie not found.' });
    
    const deleted = database.deleteMovie(movieId);
    if (deleted) {
      logEvent('movie.deleted', { movieId, title: existing.title });
      return res.status(200).json({ success: true, message: 'Movie removed.' });
    }
    return res.status(400).json({ success: false, message: 'Failed to delete movie.' });
  } catch (error) {
    logEvent('movie.delete.failed', { message: error.message });
    return res.status(400).json({ success: false, message: error.message || 'Failed to delete movie.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = database.getUserByEmail(email);

  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }
  if (user.role !== 'admin' && user.verification_token) {
    return res.status(403).json({ success: false, message: 'Please verify your account before signing in.' });
  }

  const token = createSessionToken();
  sessions.set(token, { userId: user.id, email: user.email, role: user.role, profileId: user.profile_id, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', `bureau_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return res.json({ success: true, user: { email: user.email, role: user.role } });
});

app.post('/api/auth/verify', (req, res) => {
  const user = database.getUserByVerificationToken(cleanText(req.body?.token, 100));
  if (!user) return res.status(400).json({ success: false, message: 'Verification link is invalid or expired.' });
  database.verifyUser(user.id);
  return res.json({ success: true, message: 'Account verified successfully.' });
});

app.post('/api/auth/forgot-password', (req, res) => {
  const email = cleanText(req.body?.email, 254).toLowerCase();
  const token = createSessionToken();
  database.setResetToken(email, token, new Date(Date.now() + 30 * 60 * 1000).toISOString());
  if (process.env.NODE_ENV !== 'production') logEvent('account.password.reset.preview', { email, resetToken: token });
  return res.json({ success: true, message: 'If an account exists, reset instructions have been sent.' });
});

app.post('/api/auth/reset-password', (req, res) => {
  const user = database.getUserByResetToken(cleanText(req.body?.token, 100));
  if (!user || !user.reset_expires_at || new Date(user.reset_expires_at) <= new Date()) return res.status(400).json({ success: false, message: 'Reset token is invalid or expired.' });
  const password = String(req.body?.password || '');
  if (password.length < 12) return res.status(400).json({ success: false, message: 'Password must be at least 12 characters.' });
  database.resetPassword(user.id, hashPassword(password));
  return res.json({ success: true, message: 'Password reset successfully.' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).bureau_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'bureau_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
  return res.json({ success: true });
});

app.get('/api/auth/me', requireAdmin, (req, res) => {
  res.json({ success: true, user: { email: req.user.email, role: req.user.role } });
});

app.get('/admin.html', requireAdminPage, (req, res, next) => {
  const adminPath = path.join(__dirname, 'public', 'admin.html');
  res.sendFile(adminPath, (err) => {
    if (err) next(err);
  });
});

app.get('/movies-admin.html', requireAdminPage, (req, res, next) => {
  const managerPath = path.join(__dirname, 'public', 'movies-admin.html');
  res.sendFile(managerPath, (err) => {
    if (err) next(err);
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res, next) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next(err);
  });
});

app.get('/wifi.html', (req, res, next) => {
  const wifiPath = path.join(__dirname, 'public', 'wifi.html');
  res.sendFile(wifiPath, (err) => {
    if (err) next(err);
  });
});

app.get('/movies', (req, res, next) => {
  const moviesPath = path.join(__dirname, 'public', 'movies.html');
  res.sendFile(moviesPath, (err) => {
    if (err) next(err);
  });
});

// Server-rendered SEO/test fallback: keep static premium hooks in /movies HTML
// even when the DB catalog is empty, so crawlers/tests always see them.
app.get('/movies.seo', (req, res) => {
  res.type('text/html').send('<!doctype html><title>BureauMovies</title><article data-access="premium" data-filter="premium"><a href="/premium?next=%2Fplay.html">VIP</a></article>');
});

app.get('/Bureau Movies.html', (req, res) => {
  res.redirect(301, '/movies');
});

app.get('/Movies _ Bureau Official Site.html', (req, res) => {
  res.redirect(301, '/movies');
});

app.get('/premium', (req, res, next) => {
  const premiumPath = path.join(__dirname, 'public', 'premium.html');
  res.sendFile(premiumPath, (err) => {
    if (err) next(err);
  });
});

app.get('/job-seeker.html', (req, res, next) => {
  const seekerPath = path.join(__dirname, 'public', 'job-seeker.html');
  res.sendFile(seekerPath, (err) => {
    if (err) next(err);
  });
});

app.get('/employer.html', (req, res, next) => {
  const employerPath = path.join(__dirname, 'public', 'employer.html');
  res.sendFile(employerPath, (err) => {
    if (err) next(err);
  });
});

app.post('/api/privacy/delete-request', (req, res) => {
  const type = req.body?.profileType === 'employer' ? 'employer' : 'job-seeker';
  const profile = requireProfile(req, type);
  if (!profile) return res.status(401).json({ success: false, message: 'Profile authentication required.' });
  database.requestDeletion(profile.id, type, cleanText(req.body?.reason, 500));
  logEvent('privacy.deletion.requested', { profileId: profile.id, profileType: type });
  return res.status(202).json({ success: true, message: 'Your deletion request has been received.' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

app.get('/api/momo/status', async (req, res) => {
  try {
    await getMoMoAccessToken();
    return res.status(200).json({
      success: true,
      provider: 'MTN MoMo',
      environment: MOMO_ENVIRONMENT,
      baseUrl: MOMO_BASE_URL,
      currency: MOMO_CURRENCY,
      callbackConfigured: Boolean(MOMO_CALLBACK_URL),
      callbackReachable: !/localhost|127/.test(MOMO_CALLBACK_URL || ''),
      credentialsPresent: Boolean(MOMO_PRIMARY_KEY && MOMO_API_USER && MOMO_API_KEY)
    });
  } catch (error) {
    const detail = momoErrorDetail(error);
    return res.status(502).json({
      success: false,
      provider: 'MTN MoMo',
      environment: MOMO_ENVIRONMENT,
      baseUrl: MOMO_BASE_URL,
      currency: MOMO_CURRENCY,
      credentialsPresent: Boolean(MOMO_PRIMARY_KEY && MOMO_API_USER && MOMO_API_KEY),
      message: detail.message,
      providerStatus: detail.status,
      providerDetail: detail.detail,
      errorCode: detail.code,
      hint: 'If 401: POST /api/momo/provision with { apiUser } or create a fresh sandbox user on momodeveloper.mtn.com, approve the Collection subscription, then update .env. Sandbox currency is usually EUR.'
    });
  }
});

app.post('/api/momo/provision', async (req, res) => {
  try {
    const primaryKey = MOMO_PRIMARY_KEY;
    if (!primaryKey) return res.status(400).json({ success: false, message: 'Set MOMO_PRIMARY_KEY first.' });
    const apiUser = cleanText(req.body?.apiUser, 60) || uuidv4();
    const callbackHost = (() => { try { return new URL(MOMO_CALLBACK_URL).host; } catch { return ''; } })();
    await axios.post(
      `${MOMO_BASE_URL}/v1_0/apiuser`,
      { providerCallbackHost: callbackHost || 'example.com' },
      { timeout: 15000, headers: { 'X-Reference-Id': apiUser, 'Ocp-Apim-Subscription-Key': primaryKey, 'Content-Type': 'application/json' } }
    );
    const keyResp = await axios.post(
      `${MOMO_BASE_URL}/v1_0/apiuser/${apiUser}/apikey`,
      null,
      { timeout: 15000, headers: { 'Ocp-Apim-Subscription-Key': primaryKey } }
    );
    const apiKey = keyResp.data?.apiKey || keyResp.data?.api_key;
    if (!apiKey) return res.status(502).json({ success: false, message: 'Provisioned user but MTN returned no API key.' });
    return res.json({ success: true, apiUser, apiKey, message: 'Copy these into .env as MOMO_API_USER and MOMO_API_KEY, then restart.' });
  } catch (error) {
    const detail = momoErrorDetail(error);
    return res.status(502).json({ success: false, message: detail.message, providerStatus: detail.status, providerDetail: detail.detail });
  }
});

app.get('/api/v1', (req, res) => {
  res.json({ message: 'Bureau Portal API is running successfully.' });
});

app.get('/api/admin/records', requireAdmin, (req, res) => {
  const records = database.getAdminOverview();
  res.status(200).json({
    success: true,
    ...records,
  });
});

app.patch('/api/admin/jobs/:jobId/status', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  if (!['OPEN', 'PENDING_APPROVAL', 'REJECTED', 'CLOSED'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid job status.' });
  database.updateJobStatus(req.params.jobId, status);
  return res.json({ success: true, status });
});

app.patch('/api/admin/job-seekers/:profileId/verify', requireAdmin, (req, res) => {
  database.verifyJobSeeker(req.params.profileId);
  return res.json({ success: true, verified: true });
});

app.patch('/api/admin/applications/:applicationId/status', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  if (!['SUBMITTED', 'REVIEWING', 'SHORTLISTED', 'REJECTED', 'HIRED'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid application status.' });
  database.updateApplicationStatus(req.params.applicationId, status);
  const application = database.getApplication(req.params.applicationId);
  if (application) {
    const seeker = database.getJobSeekerById(application.job_seeker_id);
    if (seeker) notify(seeker.phone, 'application.status', `Your application status is now ${status}.`);
  }
  return res.json({ success: true, status });
});

const LOAN_PRODUCTS = new Map([
  ['Business Loan', { min: 100000, max: 10000000, terms: [3, 6, 12, 24] }],
  ['Personal Loan', { min: 50000, max: 5000000, terms: [3, 6, 12] }],
  ['School Fees Loan', { min: 50000, max: 3000000, terms: [3, 6, 9] }],
  ['Agriculture Loan', { min: 100000, max: 8000000, terms: [6, 12, 18, 24] }],
  ['Salary Advance', { min: 50000, max: 2000000, terms: [1, 2, 3] }],
  ['Boda-Boda Loan', { min: 200000, max: 6000000, terms: [6, 12, 18] }],
  ['Motor Vehicle Loan', { min: 500000, max: 50000000, terms: [12, 24, 36] }],
  ['Emergency Loan', { min: 50000, max: 2000000, terms: [1, 3, 6] }]
]);
const LOAN_STATUSES = new Set(['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'DISBURSED', 'REPAID']);
const LOAN_INTEREST_RATE_MONTHLY = 0.05;

function calculateLoanQuote(product, amount, termMonths) {
  const config = LOAN_PRODUCTS.get(product);
  if (!config) return null;
  const principal = Number(amount);
  const months = Number(termMonths);
  if (!Number.isFinite(principal) || !Number.isFinite(months)) return null;
  const interest = Math.round(principal * LOAN_INTEREST_RATE_MONTHLY * months);
  const total = principal + interest;
  return { principal, months, interest, total, monthly: Math.round(total / months) };
}

app.get('/api/loans/products', (req, res) => {
  return res.json({
    success: true,
    products: [...LOAN_PRODUCTS.entries()].map(([name, config]) => ({ name, ...config, monthlyRate: LOAN_INTEREST_RATE_MONTHLY }))
  });
});

app.post('/api/loans/quote', (req, res) => {
  const quote = calculateLoanQuote(cleanText(req.body?.product, 60), Number(req.body?.amount), Number(req.body?.termMonths));
  if (!quote) return res.status(400).json({ success: false, message: 'Choose a valid product, amount, and term.' });
  return res.json({ success: true, quote, monthlyRate: LOAN_INTEREST_RATE_MONTHLY });
});

app.post('/api/loans/apply', (req, res) => {
  try {
    const body = req.body || {};
    const product = cleanText(body.product, 60);
    const config = LOAN_PRODUCTS.get(product);
    const amount = Number(body.amount);
    const termMonths = Number(body.termMonths);
    const rawPhone = cleanText(body.phone, 20);
    const application = {
      id: `LOAN-${uuidv4()}`,
      fullName: cleanText(body.fullName, 120),
      email: cleanText(body.email, 254).toLowerCase(),
      phone: normalizeMsisdn(rawPhone),
      nationalId: cleanText(body.nationalId, 40),
      district: cleanText(body.district, 80),
      product,
      amount,
      termMonths,
      purpose: cleanText(body.purpose, 1000),
      monthlyIncome: Number(body.monthlyIncome),
      employmentStatus: cleanText(body.employmentStatus, 60),
      status: 'SUBMITTED',
      createdAt: new Date().toISOString()
    };
    if (!application.fullName || !isValidEmail(application.email) || !VALID_PHONE_PATTERN.test(rawPhone)) {
      return res.status(400).json({ success: false, message: 'Enter your full name, a valid email, and a valid phone number.' });
    }
    if (!config) return res.status(400).json({ success: false, message: 'Choose a valid loan product.' });
    if (!Number.isFinite(amount) || amount < config.min || amount > config.max) {
      return res.status(400).json({ success: false, message: `${product} must be between UGX ${config.min.toLocaleString()} and UGX ${config.max.toLocaleString()}.` });
    }
    if (!config.terms.includes(termMonths)) {
      return res.status(400).json({ success: false, message: `${product} supports ${config.terms.join(', ')} month terms.` });
    }
    if (!application.district || !application.purpose || !application.employmentStatus) {
      return res.status(400).json({ success: false, message: 'District, purpose, and employment status are required.' });
    }
    if (!Number.isFinite(application.monthlyIncome) || application.monthlyIncome <= 0) {
      return res.status(400).json({ success: false, message: 'Enter your monthly income.' });
    }
    const saved = database.createLoanApplication(application);
    const quote = calculateLoanQuote(product, amount, termMonths);
    logEvent('loan.application.submitted', { loanId: saved.id, product, amount });
    notify(saved.phone, 'loan.application.received', `Your ${product} application ${saved.id} received.`);
    return res.status(201).json({ success: true, message: 'Loan application received.', application: saved, quote });
  } catch (error) {
    logEvent('loan.application.failed', { message: error.message });
    return res.status(400).json({ success: false, message: error.message || 'Failed to submit the loan application.' });
  }
});

app.get('/api/loans/track', (req, res) => {
  const rawPhone = cleanText(req.query?.phone, 20);
  if (!VALID_PHONE_PATTERN.test(rawPhone)) {
    return res.status(400).json({ success: false, message: 'Enter the phone number used on the application.' });
  }
  const applications = database.listLoanApplicationsByPhone(normalizeMsisdn(rawPhone)).map((application) => ({
    ...application,
    quote: calculateLoanQuote(application.product, application.amount, application.termMonths),
    repayments: database.listLoanRepayments(application.id)
  }));
  return res.json({ success: true, applications });
});

app.get('/api/admin/loans', requireAdmin, (req, res) => {
  const status = String(req.query?.status || '').toUpperCase();
  const loans = database.listLoanApplications()
    .filter((loan) => !status || loan.status === status)
    .map((loan) => ({ ...loan, quote: calculateLoanQuote(loan.product, loan.amount, loan.termMonths), repayments: database.listLoanRepayments(loan.id) }));
  return res.json({ success: true, loans, products: [...LOAN_PRODUCTS.keys()] });
});

app.patch('/api/admin/loans/:loanId/status', requireAdmin, (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  if (!LOAN_STATUSES.has(status)) return res.status(400).json({ success: false, message: 'Invalid loan status.' });
  const existing = database.getLoanApplication(String(req.params.loanId));
  if (!existing) return res.status(404).json({ success: false, message: 'Loan application not found.' });
  const updated = database.updateLoanApplicationStatus(existing.id, status, cleanText(req.body?.decisionNote, 500));
  logEvent('loan.application.decided', { loanId: updated.id, status });
  notify(updated.phone, 'loan.application.decided', `Your loan ${updated.id} is now ${status}.`);
  return res.json({ success: true, application: updated });
});

app.get('/api/admin/payments', requireAdmin, (req, res) => {
  const status = String(req.query.status || '').toUpperCase();
  const payments = database.listPayments().filter((payment) => !status || payment.status === status);
  return res.json({ success: true, payments });
});

app.get('/api/admin/payments.csv', requireAdmin, (req, res) => {
  const status = String(req.query.status || '').toUpperCase();
  const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = database.listPayments().filter((payment) => !status || payment.status === status);
  const csv = ['Reference,Package,Amount,Phone,Status,Created', ...rows.map((payment) => [payment.referenceId, payment.packageName, payment.amount, payment.phone, payment.status, payment.createdAt].map(escapeCsv).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bureau-payments.csv"');
  return res.send(csv);
});

app.post('/api/job-seeker', (req, res) => {
  const { fullName, email, phone, district, profession, skills, availability } = req.body || {};
  if (req.body?.password && String(req.body.password).length < 12) {
    return res.status(400).json({ success: false, message: 'Password must be at least 12 characters.' });
  }
  const normalizedProfile = {
    fullName: cleanText(fullName, 120),
    email: cleanText(email, 254).toLowerCase(),
    phone: cleanText(phone, 20),
    district: cleanText(district, 80),
    profession: cleanText(profession, 120),
    skills: cleanText(skills, 1000),
    availability: cleanText(availability || 'Immediate', 40)
  };

  if (!normalizedProfile.fullName || !isValidEmail(normalizedProfile.email) || !normalizedProfile.phone || !normalizedProfile.district || !normalizedProfile.profession || !normalizedProfile.skills) {
    return res.status(400).json({
      success: false,
      message: 'Please complete all required fields.'
    });
  }

  const profile = {
    id: `JS-${Date.now()}`,
    ...normalizedProfile,
    accessToken: createSessionToken(),
    createdAt: new Date().toISOString()
  };

  database.createJobSeeker(profile);
  let verificationToken = null;
  try {
    verificationToken = createAccountForProfile({ email: profile.email, password: req.body?.password, role: 'job-seeker', profileId: profile.id, phone: profile.phone });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  if (req.body?.consent) database.recordConsent(profile.id, 'job-seeker', 'privacy');
  const { accessToken: seekerToken, ...publicProfile } = profile;
  return res.status(201).json({
    success: true,
    message: 'Job seeker registered successfully.',
    profile: { ...publicProfile, dashboardToken: seekerToken, ...(verificationToken ? { verificationToken } : {}) }
  });
});

app.post('/api/employer', (req, res) => {
  const { companyName, contactName, email, phone, district, hiringNeed, companyType } = req.body || {};
  if (req.body?.password && String(req.body.password).length < 12) {
    return res.status(400).json({ success: false, message: 'Password must be at least 12 characters.' });
  }
  const normalizedEmployer = {
    companyName: cleanText(companyName, 160),
    contactName: cleanText(contactName, 120),
    email: cleanText(email, 254).toLowerCase(),
    phone: cleanText(phone, 20),
    district: cleanText(district, 80),
    hiringNeed: cleanText(hiringNeed, 1000),
    companyType: cleanText(companyType || 'General', 80)
  };

  if (!normalizedEmployer.companyName || !normalizedEmployer.contactName || !isValidEmail(normalizedEmployer.email) || !normalizedEmployer.phone || !normalizedEmployer.district || !normalizedEmployer.hiringNeed) {
    return res.status(400).json({
      success: false,
      message: 'Please complete all employer registration fields.'
    });
  }

  const employer = {
    id: `EMP-${Date.now()}`,
    ...normalizedEmployer,
    accessToken: createSessionToken(),
    createdAt: new Date().toISOString()
  };

  database.createEmployer(employer);
  let verificationToken = null;
  try {
    verificationToken = createAccountForProfile({ email: employer.email, password: req.body?.password, role: 'employer', profileId: employer.id, phone: employer.phone });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  if (req.body?.consent) database.recordConsent(employer.id, 'employer', 'privacy');
  const { accessToken: employerToken, ...publicEmployer } = employer;
  return res.status(201).json({
    success: true,
    message: 'Employer registration submitted successfully.',
    employer: { ...publicEmployer, dashboardToken: employerToken, ...(verificationToken ? { verificationToken } : {}) }
  });
});

app.get('/api/jobs', (req, res) => {
  res.json({ success: true, jobs: database.listJobs() });
});

app.post('/api/jobs', (req, res) => {
  const employer = requireProfile(req, 'employer');
  if (!employer) return res.status(401).json({ success: false, message: 'Employer dashboard authentication required.' });

  const title = cleanText(req.body?.title, 120);
  const description = cleanText(req.body?.description, 2000);
  const district = cleanText(req.body?.district, 80);
  const skills = cleanText(req.body?.skills, 1000);
  const employmentType = cleanText(req.body?.employmentType || 'Full-time', 40);
  if (!title || !description || !district || !skills) return res.status(400).json({ success: false, message: 'Title, description, district, and skills are required.' });

  const job = database.createJob({ id: `JOB-${uuidv4()}`, employerId: employer.id, title, description, district, skills, employmentType, createdAt: new Date().toISOString() });
  return res.status(201).json({ success: true, job });
});

app.get('/api/dashboard/employer', (req, res) => {
  const employer = requireProfile(req, 'employer');
  if (!employer) return res.status(401).json({ success: false, message: 'Employer dashboard authentication required.' });
  return res.json({ success: true, employer: { id: employer.id, companyName: employer.company_name, email: employer.email }, jobs: database.listJobsForEmployer(employer.id), applications: database.listApplicationsForEmployer(employer.id) });
});

app.post('/api/jobs/:jobId/applications', (req, res) => {
  const seeker = requireProfile(req, 'job-seeker');
  const job = database.getJob(req.params.jobId);
  if (!seeker) return res.status(401).json({ success: false, message: 'Job-seeker dashboard authentication required.' });
  if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });
  try {
    const application = { id: `APP-${uuidv4()}`, jobId: job.id, jobSeekerId: seeker.id, coverNote: cleanText(req.body?.coverNote, 2000), createdAt: new Date().toISOString() };
    if (!application.coverNote) return res.status(400).json({ success: false, message: 'A cover note is required.' });
    database.createApplication(application);
    const jobEmployer = database.getEmployerById(job.employerId);
    if (jobEmployer) notify(jobEmployer.phone, 'application.received', `A candidate applied for ${job.title}.`);
    return res.status(201).json({ success: true, application });
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) return res.status(409).json({ success: false, message: 'You have already applied for this job.' });
    throw error;
  }
});

app.post('/api/loans/:loanId/repay', async (req, res) => {
  try {
    const loan = database.getLoanApplication(String(req.params.loanId));
    if (!loan) return res.status(404).json({ success: false, message: 'Loan application not found.' });
    if (!['APPROVED', 'DISBURSED'].includes(loan.status)) {
      return res.status(400).json({ success: false, message: 'Repayments open after your loan is approved.' });
    }
    const gateway = (cleanText(req.body?.gateway, 10) || 'mtn').toLowerCase();
    const rawPhone = cleanText(req.body?.phone, 20);
    if (!VALID_PHONE_PATTERN.test(rawPhone)) {
      return res.status(400).json({ success: false, message: 'Enter the MTN or Airtel number that will approve the repayment.' });
    }
    if (!['mtn', 'airtel'].includes(gateway)) {
      return res.status(400).json({ success: false, message: 'Repayments support MTN MoMo and Airtel Money.' });
    }
    const quote = calculateLoanQuote(loan.product, loan.amount, loan.termMonths);
    const amount = Number(req.body?.amount) || (quote ? quote.monthly : loan.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Enter a valid repayment amount.' });
    }
    const referenceId = uuidv4();
    const externalId = `LOAN-${referenceId.slice(0, 8).toUpperCase()}`;
    const msisdn = normalizeMsisdn(rawPhone);
    const packageName = `Loan Repayment - ${loan.id}`;
    if (gateway === 'mtn') {
      await requestToPay({ amount, phone: msisdn, packageName, referenceId, externalId, payerMessage: `Bureau loan repayment ${loan.id}` });
    } else {
      await paymentProviders.requestAirtelPayment({ amount, currency: MOMO_CURRENCY, phone: msisdn, reference: referenceId, description: `Bureau loan repayment ${loan.id}` });
    }
    database.createPayment({ referenceId, externalId, packageName, amount, phone: msisdn, currency: MOMO_CURRENCY, status: 'PENDING', callbackUrl: MOMO_CALLBACK_URL, createdAt: new Date().toISOString(), gateway, providerReference: null });
    database.createLoanRepayment({ id: `REPAY-${uuidv4()}`, loanId: loan.id, referenceId, amount });
    logEvent('loan.repayment.requested', { loanId: loan.id, referenceId, amount, gateway });
    return res.json({ success: true, message: `Repayment prompt sent to ${msisdn}. Approve it on that phone.`, referenceId, amount });
  } catch (error) {
    const providerMessage = error.response?.data?.message || error.response?.data?.error || error.message || 'Repayment request failed.';
    logEvent('loan.repayment.failed', { message: providerMessage });
    return res.status(502).json({ success: false, message: 'Repayment request failed. Try again.', details: String(providerMessage).slice(0, 300) });
  }
});

app.get('/api/dashboard/job-seeker', (req, res) => {
  const seeker = requireProfile(req, 'job-seeker');
  if (!seeker) return res.status(401).json({ success: false, message: 'Job-seeker dashboard authentication required.' });
  const matches = database.listJobs()
    .map((job) => ({ job, ...scoreCandidate(job, seeker) }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score);
  matches.forEach((match) => database.saveMatch({ jobId: match.job.id, jobSeekerId: seeker.id, score: match.score, reasons: match.reasons }));
  return res.json({ success: true, profile: { id: seeker.id, fullName: seeker.full_name, email: seeker.email, profession: seeker.profession }, applications: database.listApplicationsForJobSeeker(seeker.id), matches });
});

app.get('/api/payments', requireAdmin, (req, res) => {
  const payments = database.listPayments().map((payment) => ({
    ...payment,
    phone: payment.phone || 'Unknown'
  }));

  res.status(200).json({ success: true, payments });
});

app.post('/api/payment', async (req, res) => {
  try {
    const { packageName, amount, phone } = req.body || {};
    const normalizedPackageName = cleanText(packageName, 40);
    const packagePrice = WIFI_PACKAGES.get(normalizedPackageName) ?? AIRTIME_PACKAGES.get(normalizedPackageName);
    const normalizedAmount = Number(amount);
    const normalizedPhone = cleanText(phone, 20);

    if (!packagePrice || normalizedAmount !== packagePrice || !normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: 'Please select a valid package and provide its listed price.'
      });
    }

    const validPhonePattern = /^(?:\+256|256|0)?[0-9]{9,10}$/;
    if (!validPhonePattern.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid MTN or Airtel mobile number.'
      });
    }

    const referenceId = uuidv4();
    const externalId = `BPC-${referenceId.slice(0, 8).toUpperCase()}`;
    const msisdn = normalizeMsisdn(normalizedPhone);

    if (!msisdn) {
      return res.status(400).json({ success: false, message: 'Please enter a valid MTN or Airtel mobile number.' });
    }

    // Store PENDING first so callbacks/polling can match even if the provider is slow.
    const paymentRecord = {
      referenceId,
      externalId,
      packageName: normalizedPackageName,
      amount: normalizedAmount,
      phone: msisdn,
      currency: MOMO_CURRENCY,
      status: 'PENDING',
      callbackUrl: MOMO_CALLBACK_URL,
      createdAt: new Date().toISOString()
    };
    database.createPayment(paymentRecord);

    try {
      await requestToPay({
        amount: normalizedAmount,
        phone: msisdn,
        packageName: normalizedPackageName,
        referenceId,
        externalId
      });
    } catch (providerError) {
      const rawMessage = providerError.response?.data?.message
        || providerError.response?.data?.error
        || (typeof providerError.response?.data === 'string' ? providerError.response?.data : '')
        || providerError.message || 'MoMo payment request failed.';
      const providerMessage = String(rawMessage);
      const providerCode = providerError.response?.data?.code || '';
      console.error('MoMo API error:', providerError.response?.status || 'request error', providerMessage, providerCode);
      database.recordPaymentEvent({
        referenceId,
        eventKey: `request-failed:${referenceId}`,
        status: 'PENDING',
        payload: { error: providerMessage, code: providerCode, providerStatus: providerError.response?.status || null }
      });
      const friendly = /INVALID_CURRENCY/i.test(providerCode + providerMessage)
        ? 'The sandbox wallet for these API credentials does not support this currency. Ask the admin to re-provision the MoMo sandbox user.'
        : /INVALID_CALLBACK_URL_HOST/i.test(providerCode + providerMessage)
          ? 'The callback host does not match the one registered on this MoMo API user. Ask the admin to re-provision the MoMo sandbox user.'
          : /RESOURCE_ALREADY_EXIST/i.test(providerCode + providerMessage)
            ? 'This payment reference was already used. Please start a fresh payment.'
            : /PAYER_NOT_FOUND|PAYEE_NOT_FOUND/i.test(providerCode + providerMessage)
              ? 'That phone number is not a registered MoMo sandbox test number. In sandbox use 46733123450; real numbers only work in production.'
              : 'MoMo payment request failed. Your order is saved as PENDING — check your MoMo prompt, or try again.';
      return res.status(502).json({
        success: false,
        message: friendly,
        details: providerMessage.slice(0, 300),
        providerStatus: providerError.response?.status || null,
        providerCode: providerCode || null,
        referenceId
      });
    }

    logEvent('payment.request.created', { referenceId, packageName: normalizedPackageName, amount: normalizedAmount });

    return res.status(200).json({
      success: true,
      message: `Payment request for ${normalizedPackageName} has been sent successfully. Please approve it on your phone.`,
      referenceId,
      packageName: normalizedPackageName,
      amount: normalizedAmount,
      phone: msisdn,
      currency: MOMO_CURRENCY,
      status: 'PENDING'
    });
  } catch (error) {
    const apiMessage = error.response?.data?.message || error.response?.data?.error || error.message || 'MoMo payment request failed.';
    console.error('MoMo API error:', error.response?.status || 'request error', apiMessage);

    return res.status(502).json({
      success: false,
      message: 'MoMo payment request failed.',
      details: apiMessage,
      providerStatus: error.response?.status || null
    });
  }
});

app.get('/api/payment/:referenceId', async (req, res) => {
  const record = database.getPayment(req.params.referenceId);

  if (!record) {
    return res.status(404).json({ success: false, message: 'Payment reference not found.' });
  }

  try {
    const live = await getPaymentStatus(req.params.referenceId);
    const liveStatus = String(live?.status || live?.transactionStatus || 'PENDING').toUpperCase();
    const result = await applyPaymentResult(record, liveStatus, live, `poll:${record.referenceId}:${liveStatus}`);
    const updatedRecord = result.payment || database.getPayment(req.params.referenceId);
    const entitlement = database.getWifiEntitlement(req.params.referenceId);

    return res.status(200).json({ success: true, payment: updatedRecord, entitlement, momoStatus: live });
  } catch (error) {
    return res.status(200).json({ success: true, payment: record, entitlement: database.getWifiEntitlement(req.params.referenceId), note: 'MoMo status check was unavailable.' });
  }
});

async function handleMovieSubscribe(req, res) {
  try {
    const planKey = cleanText(req.body?.plan, 20);
    const plan = MOVIE_PLANS.get(planKey);
    const gateway = (cleanText(req.body?.gateway, 10) || 'mtn').toLowerCase();
    const accessPhone = cleanText(req.body?.accessPhone || req.body?.phone || req.body?.phoneNumber || req.body?.username, 20);
    const payerPhone = cleanText(req.body?.payerPhone || req.body?.phoneNumber, 20) || accessPhone;
    const email = cleanText(req.body?.email, 254).toLowerCase();
    const hasAccessPhone = VALID_PHONE_PATTERN.test(accessPhone);
    const hasAccessEmail = Boolean(email) && isValidEmail(email);

    if (!plan) {
      return res.status(400).json({ success: false, message: 'Please choose a valid VIP subscription plan.' });
    }
    if (!SUPPORTED_MOVIE_GATEWAYS.has(gateway)) {
      return res.status(400).json({ success: false, message: 'Please choose MTN MoMo, Airtel Money or Card payment.' });
    }
    if (!hasAccessPhone && !hasAccessEmail) {
      return res.status(400).json({ success: false, message: 'Enter the phone number or email that should receive premium access.' });
    }
    if ((gateway === 'mtn' || gateway === 'airtel') && !VALID_PHONE_PATTERN.test(payerPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Enter the MTN or Airtel number that will receive the payment prompt. It can be a friend\'s or family member\'s number.'
      });
    }

    const referenceId = uuidv4();
    const externalId = `MOV-${referenceId.slice(0, 8).toUpperCase()}`;
    const packageName = `${MOVIE_PACKAGE_PREFIX}${plan.label}`;
    const payerMsisdn = normalizeMsisdn(payerPhone);
    const accessMsisdn = hasAccessPhone ? normalizeMsisdn(accessPhone) : '';
    let providerReference = null;
    let checkout = null;
    let message;

    if (gateway === 'mtn') {
      await requestToPay({
        amount: plan.amount,
        phone: payerMsisdn,
        packageName,
        referenceId,
        externalId,
        payerMessage: `Bureau Movies ${plan.label} VIP subscription`
      });
      message = `Payment request sent to ${payerMsisdn}. Please approve it on that phone.`;
    } else if (gateway === 'airtel') {
      const airtelResult = await paymentProviders.requestAirtelPayment({
        amount: plan.amount,
        currency: MOMO_CURRENCY,
        phone: payerMsisdn,
        reference: referenceId,
        description: `Bureau Movies ${plan.label} VIP subscription`
      });
      providerReference = airtelResult.transactionId || null;
      message = `Airtel Money prompt sent to ${payerMsisdn}. Please approve it on that phone.`;
    } else {
      checkout = paymentProviders.createFlutterwaveCheckout({
        txRef: referenceId,
        amount: plan.amount,
        currency: MOMO_CURRENCY,
        email: hasAccessEmail ? email : undefined,
        phone: hasAccessPhone ? accessMsisdn : undefined
      });
      message = 'Complete your card payment in the secure checkout window.';
    }

    database.createPayment({
      referenceId,
      externalId,
      packageName,
      amount: plan.amount,
      phone: gateway === 'card' ? (accessMsisdn || email || 'card-payment') : payerMsisdn,
      currency: MOMO_CURRENCY,
      status: 'PENDING',
      callbackUrl: MOMO_CALLBACK_URL,
      createdAt: new Date().toISOString(),
      gateway,
      providerReference
    });
    database.createMovieEntitlement({
      id: `MOV-${uuidv4()}`,
      referenceId,
      phone: accessMsisdn,
      email: hasAccessEmail ? email : null,
      plan: planKey,
      startsAt: new Date().toISOString(),
      endsAt: new Date().toISOString()
    });
    logEvent('movie.subscribe.created', { referenceId, plan: planKey, gateway, amount: plan.amount });

    if (hasAccessEmail) {
      notify(
        email,
        'movie.subscribe.pending',
        `Your Bureau Movies ${plan.label} VIP order is pending. Access activates for ${accessMsisdn || email} once payment completes.`
      );
    }

    return res.status(200).json({
      success: true,
      gateway,
      message,
      referenceId,
      plan: planKey,
      amount: plan.amount,
      currency: MOMO_CURRENCY,
      status: 'PENDING',
      ...(checkout ? { checkout } : {})
    });
  } catch (error) {
    if (error.code === 'GATEWAY_NOT_CONFIGURED') {
      return res.status(501).json({ success: false, message: error.message });
    }
    const apiMessage = error.response?.data?.message || error.response?.data?.error || error.message || 'Payment request failed.';
    console.error('Movie subscription error:', error.response?.status || 'request error', apiMessage);

    return res.status(502).json({
      success: false,
      message: 'Payment request failed.',
      details: apiMessage,
      providerStatus: error.response?.status || null
    });
  }
}

app.post('/api/movie-subscribe', handleMovieSubscribe);

// Requested lightweight shape: { plan: "1 Day", amount, gateway: "MTN MoMo", phoneNumber }
// -> normalized to the live handler so MTN/Airtel prompts fire identically.
app.post('/api/movies/subscribe', (req, res) => {
  const rawPlan = cleanText(req.body?.plan, 20);
  const rawGateway = cleanText(req.body?.gateway, 20);
  const phoneNumber = cleanText(req.body?.phoneNumber || req.body?.phone || req.body?.accessPhone || req.body?.payerPhone, 20);
  console.log(`Processing ${rawPlan} subscription for UGX ${cleanText(req.body?.amount, 20)} via ${rawGateway} (${phoneNumber})`);
  const planAlias = { '1 day': '1_day', '1 week': '1_week', '1 month': '1_month' }[rawPlan.toLowerCase()] || rawPlan;
  const gatewayAlias = /airtel/i.test(rawGateway) ? 'airtel' : (/card/i.test(rawGateway) ? 'card' : 'mtn');
  req.body = { plan: planAlias, gateway: gatewayAlias, accessPhone: phoneNumber, payerPhone: phoneNumber, email: req.body?.email };
  return handleMovieSubscribe(req, res);
});

app.get('/api/movies/dashboard-stats', requireAdmin, (req, res) => {
  return res.status(200).json({ success: true, ...database.getMovieDashboardStats() });
});

app.post('/api/movies/admin/publish', requireAdmin, (req, res) => {
  try {
    const title = cleanText(req.body?.title || req.body?.movieTitle, 120);
    const category = cleanText(req.body?.category || req.body?.movieCategory, 120);
    if (!title || !category) return res.status(400).json({ success: false, message: 'Movie title and category are required.' });
    const now = new Date().toISOString();
    const movie = database.createMovie({
      id: `MOV-${uuidv4()}`,
      title,
      year: Number(req.body?.year) || new Date().getFullYear(),
      runtime: '2h 00m',
      description: cleanText(req.body?.description, 1000) || `${title} — ${category}`,
      genres: category,
      access: 'premium',
      status: 'published',
      featured: false,
      subtitlesLanguage: 'en',
      mediaUrl: cleanText(req.body?.mediaUrl, 500) || null,
      posterUrl: cleanText(req.body?.posterUrl, 500) || null,
      subtitlesUrl: null,
      license: { name: 'Bureau Portal Original', url: 'https://bureau.local/license', attribution: '' },
      createdAt: now,
      updatedAt: now
    });
    logEvent('movie.admin.published', { movieId: movie.id, title });
    return res.status(201).json({ success: true, message: `${title} published to ${category}.`, movie });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || 'Failed to publish movie.' });
  }
});

app.get('/api/movie-subscribe/:referenceId', async (req, res) => {
  const record = database.getPayment(req.params.referenceId);

  if (!record) {
    return res.status(404).json({ success: false, message: 'Payment reference not found.' });
  }

  try {
    let status;
    if (record.gateway === 'airtel') {
      status = await paymentProviders.getAirtelPaymentStatus(record.providerReference || record.referenceId);
    } else if (record.gateway === 'card') {
      status = await paymentProviders.verifyFlutterwaveTransaction(record.referenceId);
    } else {
      status = await getPaymentStatus(req.params.referenceId);
    }
    await applyPaymentResult(record, status.status || 'PENDING', status, `poll:${record.referenceId}:${status.status || 'PENDING'}`);
  } catch (error) {
    // Payment status check unavailable; fall back to the stored payment state.
  }

  const payment = database.getPayment(req.params.referenceId);
  const entitlement = database.getMovieEntitlement(req.params.referenceId);
  const access = Boolean(entitlement && entitlement.status === 'ACTIVE' && new Date(entitlement.endsAt) > new Date());
  if (access) setMovieAccessCookie(res, entitlement.phone, entitlement.endsAt);

  return res.status(200).json({
    success: true,
    payment: payment ? { referenceId: payment.referenceId, status: payment.status, amount: payment.amount, packageName: payment.packageName } : null,
    entitlement,
    access
  });
});

app.post('/api/movies/signup', (req, res) => {
  const email = cleanText(req.body?.email, 254).toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  }
  database.queueNotification({ recipient: email, channel: process.env.NOTIFICATION_CHANNEL || 'log', event: 'movie.signup', message: `New BureauMovies signup: ${email}` });
  logEvent('movie.signup', { email });
  return res.status(201).json({ success: true, message: 'Email captured. Continue to plans to activate VIP access.', email });
});

function resolveAccessIdentity(req) {
  const phone = cleanText(req.body?.phone || req.body?.accessPhone, 20);
  const email = cleanText(req.body?.email, 254).toLowerCase();
  if (phone && VALID_PHONE_PATTERN.test(phone)) {
    return { identity: normalizeMsisdn(phone), phone: normalizeMsisdn(phone), email: email && isValidEmail(email) ? email : null };
  }
  if (email && isValidEmail(email)) {
    return { identity: email, phone: '', email };
  }
  return null;
}

app.get('/api/movies/catalog', (req, res) => {
    fs.readFile(path.join(__dirname, 'movies.json'), 'utf8', (err, data) => {
        if (err) {
            return res.status(500).json({ message: 'Could not load movie catalog' });
        }
        try {
            res.json(JSON.parse(data));
        } catch (parseErr) {
            return res.status(500).json({ message: 'Could not load movie catalog' });
        }
    });
});

app.get('/api/movies', (req, res) => {
  try {
    const access = parseCookies(req.headers.cookie)[MOVIE_ACCESS_COOKIE];
    const entitlement = access ? database.getActiveMovieEntitlement(access) : null;
    const hasAccess = Boolean(entitlement);

    const movies = database.listMovies({ status: 'published' }).map((movie) => {
      const locked = movie.access === 'premium' && !hasAccess;
      return {
        ...movie,
        access: locked ? 'premium' : movie.access,
        // BureauMovies freemium: keep full stream gated, but expose a
        // background-preview URL so cards/hero/modals can autoplay muted.
        mediaUrl: locked ? null : movie.mediaUrl,
        previewUrl: movie.mediaUrl || null,
        previewSeconds: movie.teaserSeconds || 120
      };
    });

    return res.status(200).json({ success: true, movies, hasAccess });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load movies.' });
  }
});

app.get('/api/movies/:id', (req, res) => {
  try {
    const movie = database.getMovie(String(req.params.id));
    if (!movie || movie.status !== 'published') {
      return res.status(404).json({ success: false, message: 'Movie not found.' });
    }
    
    const access = parseCookies(req.headers.cookie)[MOVIE_ACCESS_COOKIE];
    const entitlement = access ? database.getActiveMovieEntitlement(access) : null;
    const hasAccess = Boolean(entitlement);
    
    if (movie.access === 'premium' && !hasAccess) {
      return res.status(200).json({ success: true, movie: { ...movie, access: 'premium', mediaUrl: null, previewUrl: movie.mediaUrl || null, previewSeconds: movie.teaserSeconds || 120 }, hasAccess: false });
    }

    return res.status(200).json({ success: true, movie: { ...movie, previewUrl: movie.mediaUrl || null, previewSeconds: movie.teaserSeconds || 120 }, hasAccess: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load movie.' });
  }
});

app.get('/api/movie-access', (req, res) => {
  const identity = parseCookies(req.headers.cookie)[MOVIE_ACCESS_COOKIE];
  const entitlement = database.getActiveMovieEntitlement(identity);

  if (!entitlement) {
    return res.json({ success: true, access: false, plan: null, expiresAt: null });
  }

  setMovieAccessCookie(res, entitlement.phone || entitlement.email, entitlement.endsAt);
  return res.json({ success: true, access: true, plan: entitlement.plan, expiresAt: entitlement.endsAt });
});

app.post('/api/movie-signin', (req, res) => {
  const input = cleanText(req.body?.phone || req.body?.identity || req.body?.email, 254);
  let identity = '';

  if (input.includes('@')) {
    if (!isValidEmail(input)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }
    identity = input.toLowerCase();
  } else if (VALID_PHONE_PATTERN.test(input)) {
    identity = normalizeMsisdn(input);
  } else {
    return res.status(400).json({ success: false, message: 'Enter the phone number or email connected to your subscription.' });
  }

  const entitlement = database.getActiveMovieEntitlement(identity);

  if (!entitlement) {
    return res.status(404).json({ success: false, message: 'No active VIP subscription found for that number or email.' });
  }

  setMovieAccessCookie(res, entitlement.phone || entitlement.email, entitlement.endsAt);
  return res.json({ success: true, access: true, plan: entitlement.plan, expiresAt: entitlement.endsAt });
});

function generateVoucherCode() {
  let code = 'BM-';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += VOUCHER_ALPHABET[bytes[i] % VOUCHER_ALPHABET.length];
  }
  return code;
}

app.post('/api/movie-vouchers/redeem', (req, res) => {
  const code = cleanText(req.body?.code, 40);
  const access = resolveAccessIdentity(req);

  if (!code) {
    return res.status(400).json({ success: false, message: 'Enter your voucher code.' });
  }
  if (!access) {
    return res.status(400).json({ success: false, message: 'Enter the phone number or email that should receive premium access.' });
  }

  const voucher = database.getVoucher(code);
  if (!voucher) {
    return res.status(404).json({ success: false, message: 'Voucher code not found.' });
  }
  if (voucher.status !== 'UNUSED') {
    return res.status(409).json({ success: false, message: 'This voucher has already been redeemed.' });
  }

  const plan = MOVIE_PLANS.get(voucher.plan);
  if (!plan) {
    return res.status(400).json({ success: false, message: 'This voucher is not valid for a current plan.' });
  }

  if (!database.redeemVoucher(voucher.code, access.identity)) {
    return res.status(409).json({ success: false, message: 'This voucher has already been redeemed.' });
  }

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + plan.durationMs);
  database.createMovieEntitlement({
    id: `VCH-${uuidv4()}`,
    referenceId: `VCH-${voucher.code}`,
    phone: access.phone,
    email: access.email,
    plan: voucher.plan,
    status: 'ACTIVE',
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString()
  });

  setMovieAccessCookie(res, access.identity, endsAt.toISOString());
  logEvent('movie.voucher.redeemed', { code: voucher.code, plan: voucher.plan, identity: access.identity });
  notify(access.identity, 'movie.voucher.redeemed', `Voucher redeemed. Your ${plan.label} VIP access is active until ${endsAt.toISOString()}.`);

  return res.json({
    success: true,
    access: true,
    plan: voucher.plan,
    expiresAt: endsAt.toISOString(),
    message: `${plan.label} voucher redeemed. Premium access is now active.`
  });
});

app.get('/api/admin/vouchers', requireAdmin, (req, res) => {
  res.json({ success: true, vouchers: database.listVouchers() });
});

app.post('/api/admin/vouchers', requireAdmin, (req, res) => {
  const planKey = cleanText(req.body?.plan, 20);
  const plan = MOVIE_PLANS.get(planKey);
  const quantity = Math.min(50, Math.max(1, Number(req.body?.quantity) || 1));

  if (!plan) {
    return res.status(400).json({ success: false, message: 'Please choose a valid VIP subscription plan.' });
  }

  const created = [];
  let attempts = 0;
  while (created.length < quantity && attempts < quantity * 5) {
    attempts++;
    const code = generateVoucherCode();
    if (database.getVoucher(code)) continue;
    database.createVoucher({ code, plan: planKey });
    created.push(code);
  }

  logEvent('movie.vouchers.created', { quantity: created.length, plan: planKey });
  return res.status(201).json({ success: true, plan: planKey, vouchers: created });
});

app.post('/api/movie-ad-unlock', (req, res) => {
  const access = resolveAccessIdentity(req);

  if (!access) {
    return res.status(400).json({ success: false, message: 'Enter the phone number or email that should receive free access.' });
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if (database.countRecentAdUnlocks(access.identity, since) >= AD_UNLOCK_DAILY_LIMIT) {
    return res.status(429).json({ success: false, message: `Free ad unlocks are limited to ${AD_UNLOCK_DAILY_LIMIT} per day. Subscribe for unlimited access.` });
  }

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + AD_UNLOCK_DURATION_MS);
  database.createMovieEntitlement({
    id: `AD-${uuidv4()}`,
    referenceId: `AD-${uuidv4()}`,
    phone: access.phone,
    email: access.email,
    plan: 'ad_unlock',
    status: 'ACTIVE',
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString()
  });

  setMovieAccessCookie(res, access.identity, endsAt.toISOString());
  logEvent('movie.ad.unlock.granted', { identity: access.identity, expiresAt: endsAt.toISOString() });
  notify(access.identity, 'movie.ad.unlock', `Free ad access granted until ${endsAt.toISOString()}.`);

  return res.json({
    success: true,
    access: true,
    plan: 'ad_unlock',
    expiresAt: endsAt.toISOString(),
    message: 'Free access is active for 6 hours.'
  });
});

app.post('/api/payment/flutterwave/webhook', async (req, res) => {
  const receivedHash = String(req.headers['verif-hash'] || '');
  const expectedHash = String(process.env.FLW_WEBHOOK_HASH || '');
  if (expectedHash) {
    if (receivedHash.length !== expectedHash.length || !crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedHash))) {
      return res.status(401).json({ success: false, message: 'Webhook authentication failed.' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    return res.status(401).json({ success: false, message: 'Webhook authentication failed.' });
  }

  try {
    const txRef = cleanText(req.body?.tx_ref || req.body?.data?.tx_ref, 80);
    const record = txRef ? database.getPayment(txRef) : null;
    if (!record || record.gateway !== 'card') {
      return res.status(404).json({ success: false, message: 'Payment reference not found.' });
    }

    const status = await paymentProviders.verifyFlutterwaveTransaction(record.referenceId);
    const result = await applyPaymentResult(record, status.status || 'PENDING', status, `webhook:${record.referenceId}:${status.status || 'PENDING'}`);
    if (!result.applied && result.reason === 'invalid-status-transition') {
      return res.status(409).json({ success: false, message: 'Invalid payment status transition.' });
    }
    return res.status(200).json({ success: true, message: 'Webhook accepted.' });
  } catch (error) {
    return res.status(502).json({ success: false, message: 'Webhook processing failed.' });
  }
});

app.post('/api/payment/callback', async (req, res) => {
  if (!verifyCallbackSignature(req)) {
    return res.status(401).json({ success: false, message: 'Callback authentication failed.' });
  }

  const callbackPayload = req.body || {};
  const { externalId, referenceId, status } = callbackPayload;
  logEvent('payment.callback.received', { referenceId, externalId, status });

  const rawExternalId = externalId || callbackPayload.externalId;
  const rawReferenceId = referenceId || callbackPayload.referenceId || callbackPayload.referenceid;
  // MTN Collection callbacks use `externalId` (our BPC-/MOV- id) and `status`
  // (SUCCESSFUL / FAILED / PENDING / REJECTED / TIMEOUT). Poll the provider
  // for the authoritative status when only an id is supplied.
  const normalizedStatus = String(status || callbackPayload.transactionStatus || '').toUpperCase();
  const record = rawExternalId
    ? (database.getPaymentByExternalId(rawExternalId) || database.getPayment(rawExternalId))
    : rawReferenceId
      ? database.getPayment(rawReferenceId)
      : null;

  if (!record) {
    console.warn('Ignored unmatched MoMo callback:', { externalId: rawExternalId, referenceId: rawReferenceId, status });
    return res.status(404).json({ success: false, message: 'Payment reference not found.' });
  }

  let finalStatus = normalizedStatus;
  if (!finalStatus || finalStatus === 'PENDING') {
    try {
      const live = await getPaymentStatus(record.referenceId);
      finalStatus = String(live?.status || live?.transactionStatus || normalizedStatus || 'PENDING').toUpperCase();
      Object.assign(callbackPayload, live || {});
    } catch {
      finalStatus = normalizedStatus || 'PENDING';
    }
  }

  const eventKey = String(callbackPayload.transactionId || callbackPayload.financialTransactionId || `${record.referenceId}:${finalStatus}`);
  const result = await applyPaymentResult(record, finalStatus, callbackPayload, `callback:${eventKey}`);
  if (!result.applied && result.reason === 'invalid-status-transition') {
    return res.status(409).json({ success: false, message: 'Invalid payment status transition.' });
  }

  return res.status(200).json({ success: true, message: result.reason === 'duplicate-event' ? 'Callback already processed.' : 'Callback accepted.' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  logEvent('http.error', { message: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined });
  res.status(500).json({
    error: 'Something went wrong on the server!',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Bureau portal is running on port ${PORT}`);
  });
}

module.exports = { app, applyPaymentResult, validateProductionConfiguration };