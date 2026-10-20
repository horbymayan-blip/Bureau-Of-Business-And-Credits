const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedHash] = String(storedHash || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHash) return false;

  const actualHash = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  return expectedBuffer.length === actualHash.length && crypto.timingSafeEqual(actualHash, expectedBuffer);
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { createSessionToken, hashPassword, verifyPassword };
