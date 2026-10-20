const axios = require('axios');

/*
 * Alternative payment gateways for Bureau Movies VIP subscriptions.
 *
 * All configuration is read from environment variables at call time (so this
 * module can be required before dotenv.config() runs):
 *
 *   Airtel Money : AIRTEL_CLIENT_ID, AIRTEL_CLIENT_SECRET,
 *                  AIRTEL_BASE_URL (default https://openapi.airtel.africa,
 *                  use https://openapiuat.airtel.africa for the UAT sandbox),
 *                  AIRTEL_COUNTRY (default UG), AIRTEL_CURRENCY (default UGX)
 *   Card payments: FLW_PUBLIC_KEY, FLW_SECRET_KEY (Flutterwave test/live keys),
 *                  FLW_WEBHOOK_HASH (verif-hash sent with Flutterwave webhooks)
 *
 * Endpoints follow the public provider docs:
 *   Airtel Africa : POST /auth/oauth2/token, POST /standard/v1/payments,
 *                   GET  /standard/v1/payments/{transactionId}
 *                   (status codes TS = success, TF = failed, TIP/TA = in progress)
 *   Flutterwave    : GET  /v3/transactions/verify_by_reference?tx_ref=...
 *                   (card checkout runs through the hosted FlutterwaveCheckout widget)
 */

function airtelConfigured() {
  return Boolean(process.env.AIRTEL_CLIENT_ID && process.env.AIRTEL_CLIENT_SECRET);
}

function flutterwaveConfigured() {
  return Boolean(process.env.FLW_PUBLIC_KEY && process.env.FLW_SECRET_KEY);
}

function notConfigured(gateway) {
  const error = new Error(`${gateway} payments are not configured on this server.`);
  error.code = 'GATEWAY_NOT_CONFIGURED';
  return error;
}

function airtelBaseUrl() {
  return String(process.env.AIRTEL_BASE_URL || 'https://openapi.airtel.africa').replace(/\/+$/, '');
}

async function getAirtelToken() {
  const clientId = process.env.AIRTEL_CLIENT_ID;
  const clientSecret = process.env.AIRTEL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw notConfigured('Airtel Money');

  const response = await axios.post(
    `${airtelBaseUrl()}/auth/oauth2/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    {
      timeout: 15000,
      auth: { username: clientId, password: clientSecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );

  const raw = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : response.data;
  let payload = raw;
  if (typeof raw === 'string') {
    try { payload = JSON.parse(raw); } catch { payload = { access_token: raw }; }
  }
  const token = typeof payload === 'string' ? payload : payload.access_token;
  if (!token) throw new Error('Airtel token response did not include an access token.');
  return token;
}

async function requestAirtelPayment({ amount, currency, phone, reference, description }) {
  if (!airtelConfigured()) throw notConfigured('Airtel Money');

  const country = String(process.env.AIRTEL_COUNTRY || 'UG').toUpperCase();
  const token = await getAirtelToken();
  const response = await axios.post(
    `${airtelBaseUrl()}/standard/v1/payments`,
    {
      Reference: reference,
      Subscriber: { Country: country, Currency: currency, MSISDN: String(phone).replace(/^\+/, '') },
      Transaction: { Amount: Number(amount), Country: country, Currency: currency, Desc: description }
    },
    {
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Country': country,
        'X-Currency': currency,
        'Content-Type': 'application/json'
      }
    }
  );

  const data = response.data || {};
  const transaction = data.data?.transaction || {};
  return {
    transactionId: transaction.id || transaction.airtel_money_id || '',
    providerResponse: data
  };
}

function mapAirtelStatus(rawStatus) {
  const status = String(rawStatus || '').toUpperCase();
  if (status === 'TS' || status === 'SUCCESS' || status === 'SUCCESSFUL') return 'SUCCESSFUL';
  if (status === 'TF' || status === 'FAILED') return 'FAILED';
  return 'PENDING';
}

async function getAirtelPaymentStatus(transactionId) {
  if (!airtelConfigured()) throw notConfigured('Airtel Money');
  const response = await axios.get(
    `${airtelBaseUrl()}/standard/v1/payments/${encodeURIComponent(transactionId)}`,
    {
      timeout: 15000,
      headers: { Authorization: `Bearer ${await getAirtelToken()}` }
    }
  );
  const data = response.data || {};
  const rawStatus = data.data?.transaction?.status || data.status || data.data?.status;
  return { status: mapAirtelStatus(rawStatus), provider: data };
}

function createFlutterwaveCheckout({ txRef, amount, currency, email, phone }) {
  if (!flutterwaveConfigured()) throw notConfigured('Card payments');
  return {
    publicKey: process.env.FLW_PUBLIC_KEY,
    txRef,
    amount: Number(amount),
    currency,
    customer: {
      ...(email ? { email } : {}),
      ...(phone ? { phone_number: phone } : {})
    },
    payment_options: 'card,ussd,banktransfer',
    meta: { product: 'Bureau Movies VIP' }
  };
}

function mapFlutterwaveStatus(rawStatus) {
  const status = String(rawStatus || '').toLowerCase();
  if (status === 'successful' || status === 'success') return 'SUCCESSFUL';
  if (status === 'failed' || status === 'cancelled' || status === 'canceled') return 'FAILED';
  return 'PENDING';
}

async function verifyFlutterwaveTransaction(txRef) {
  if (!flutterwaveConfigured()) throw notConfigured('Card payments');
  const response = await axios.get(
    'https://api.flutterwave.com/v3/transactions/verify_by_reference',
    {
      timeout: 15000,
      params: { tx_ref: txRef },
      headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }
    }
  );
  const data = response.data || {};
  const transaction = data.data || {};
  return { status: mapFlutterwaveStatus(transaction.status), provider: data };
}

module.exports = {
  airtelConfigured,
  flutterwaveConfigured,
  requestAirtelPayment,
  getAirtelPaymentStatus,
  createFlutterwaveCheckout,
  verifyFlutterwaveTransaction
};