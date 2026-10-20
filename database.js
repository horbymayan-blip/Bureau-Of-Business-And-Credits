const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dataDirectory = path.join(__dirname, 'data');
fs.mkdirSync(dataDirectory, { recursive: true });

const database = new DatabaseSync(path.join(dataDirectory, 'bureau-portal.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS loan_applications (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    national_id TEXT,
    district TEXT NOT NULL,
    product TEXT NOT NULL,
    amount REAL NOT NULL,
    term_months INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    monthly_income REAL NOT NULL,
    employment_status TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'SUBMITTED',
    decision_note TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS loan_repayments (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL,
    reference_id TEXT NOT NULL UNIQUE,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    profile_id TEXT,
    phone TEXT,
    verified_at TEXT,
    verification_token TEXT,
    reset_token TEXT,
    reset_expires_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_seekers (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    district TEXT NOT NULL,
    profession TEXT NOT NULL,
    skills TEXT NOT NULL,
    availability TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS employers (
    id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    district TEXT NOT NULL,
    hiring_need TEXT NOT NULL,
    company_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    reference_id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    package_name TEXT NOT NULL,
    amount REAL NOT NULL,
    phone TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    callback_url TEXT,
    created_at TEXT NOT NULL,
    checked_at TEXT,
    updated_at TEXT,
    provider_payload TEXT
  );

  CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference_id TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wifi_entitlements (
    id TEXT PRIMARY KEY,
    reference_id TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    package_name TEXT NOT NULL,
    status TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wifi_provisioning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entitlement_id TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_reference TEXT,
    response_payload TEXT,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS movie_entitlements (
    id TEXT PRIMARY KEY,
    reference_id TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    plan TEXT NOT NULL,
    email TEXT,
    status TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vouchers (
    code TEXT PRIMARY KEY,
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNUSED',
    created_at TEXT NOT NULL,
    redeemed_at TEXT,
    redeemed_by_identity TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    employer_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    district TEXT NOT NULL,
    skills TEXT NOT NULL,
    employment_type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    job_seeker_id TEXT NOT NULL,
    cover_note TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(job_id, job_seeker_id)
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    job_seeker_id TEXT NOT NULL,
    score REAL NOT NULL,
    reasons TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(job_id, job_seeker_id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    channel TEXT NOT NULL,
    event TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS consent_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    profile_type TEXT NOT NULL,
    consent_type TEXT NOT NULL,
    granted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deletion_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    profile_type TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'REQUESTED',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drive_file_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER,
    web_view_link TEXT,
    related_profile_id TEXT,
    related_profile_type TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS movie_users (
    phone TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS movies (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    year INTEGER NOT NULL,
    runtime TEXT NOT NULL,
    description TEXT NOT NULL,
    genres TEXT NOT NULL,
    access TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'published',
    featured INTEGER NOT NULL DEFAULT 0,
    subtitles_language TEXT DEFAULT 'en',
    media_url TEXT NOT NULL,
    poster_url TEXT,
    subtitles_url TEXT,
    license_name TEXT NOT NULL,
    license_url TEXT NOT NULL,
    license_attribution TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

for (const statement of [
  'ALTER TABLE job_seekers ADD COLUMN access_token TEXT',
  'ALTER TABLE employers ADD COLUMN access_token TEXT',
  'ALTER TABLE payments ADD COLUMN gateway TEXT',
  'ALTER TABLE payments ADD COLUMN provider_reference TEXT',
  'ALTER TABLE movie_entitlements ADD COLUMN email TEXT',
  'ALTER TABLE movie_users ADD COLUMN email TEXT'
]) {
  try {
    database.exec(statement);
  } catch (error) {
    if (!String(error.message).includes('duplicate column name')) throw error;
  }
}
database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_job_seekers_access_token ON job_seekers(access_token) WHERE access_token IS NOT NULL');
database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_employers_access_token ON employers(access_token) WHERE access_token IS NOT NULL');

for (const statement of [
  'ALTER TABLE users ADD COLUMN profile_id TEXT',
  'ALTER TABLE users ADD COLUMN phone TEXT',
  'ALTER TABLE users ADD COLUMN verified_at TEXT',
  'ALTER TABLE users ADD COLUMN verification_token TEXT',
  'ALTER TABLE users ADD COLUMN reset_token TEXT',
  'ALTER TABLE users ADD COLUMN reset_expires_at TEXT',
  'ALTER TABLE job_seekers ADD COLUMN verified_at TEXT',
  'ALTER TABLE employers ADD COLUMN verified_at TEXT'
]) {
  try { database.exec(statement); } catch (error) {
    if (!String(error.message).includes('duplicate column name')) throw error;
  }
}

function parsePayment(row) {
  if (!row) return null;
  return {
    referenceId: row.reference_id,
    externalId: row.external_id,
    packageName: row.package_name,
    amount: row.amount,
    phone: row.phone,
    currency: row.currency,
    status: row.status,
    callbackUrl: row.callback_url,
    gateway: row.gateway || 'mtn',
    ...(row.provider_reference ? { providerReference: row.provider_reference } : {}),
    createdAt: row.created_at,
    ...(row.checked_at ? { checkedAt: row.checked_at } : {}),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    ...(row.provider_payload ? { providerPayload: JSON.parse(row.provider_payload) } : {})
  };
}

const statements = {
  findUser: database.prepare('SELECT id, email, password_hash, role, profile_id, verified_at, verification_token FROM users WHERE email = ?'),
  createUser: database.prepare('INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)'),
  updateUserPassword: database.prepare('UPDATE users SET email = ?, password_hash = ? WHERE role = ?'),
  createAccount: database.prepare('INSERT INTO users (email, password_hash, role, profile_id, phone, verification_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  findUserByVerificationToken: database.prepare('SELECT * FROM users WHERE verification_token = ?'),
  verifyUser: database.prepare('UPDATE users SET verified_at = ?, verification_token = NULL WHERE id = ?'),
  setResetToken: database.prepare('UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE email = ?'),
  findUserByResetToken: database.prepare('SELECT * FROM users WHERE reset_token = ?'),
  resetPassword: database.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?'),
  findUserByProfile: database.prepare('SELECT * FROM users WHERE profile_id = ? AND role = ?'),
  countUsers: database.prepare('SELECT COUNT(*) AS count FROM users'),
  createJobSeeker: database.prepare(`
    INSERT INTO job_seekers
      (id, full_name, email, phone, district, profession, skills, availability, created_at, access_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  createEmployer: database.prepare(`
    INSERT INTO employers
      (id, company_name, contact_name, email, phone, district, hiring_need, company_type, created_at, access_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listJobSeekers: database.prepare('SELECT * FROM job_seekers ORDER BY created_at DESC'),
  listEmployers: database.prepare('SELECT * FROM employers ORDER BY created_at DESC'),
  findJobSeekerByToken: database.prepare('SELECT * FROM job_seekers WHERE access_token = ?'),
  findJobSeekerById: database.prepare('SELECT * FROM job_seekers WHERE id = ?'),
  findEmployerByToken: database.prepare('SELECT * FROM employers WHERE access_token = ?'),
  findEmployerById: database.prepare('SELECT * FROM employers WHERE id = ?'),
  createPayment: database.prepare(`
    INSERT INTO payments
      (reference_id, external_id, package_name, amount, phone, currency, status, callback_url, created_at, gateway, provider_reference)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  findPayment: database.prepare('SELECT * FROM payments WHERE reference_id = ?'),
  findPaymentByExternalId: database.prepare('SELECT * FROM payments WHERE external_id = ?'),
  listPayments: database.prepare('SELECT * FROM payments ORDER BY created_at DESC'),
  updatePayment: database.prepare(`
    UPDATE payments
    SET status = ?, checked_at = ?, updated_at = ?, provider_payload = ?
    WHERE reference_id = ?
  `),
  createPaymentEvent: database.prepare('INSERT INTO payment_events (reference_id, event_key, status, payload, created_at) VALUES (?, ?, ?, ?, ?)'),
  findPaymentEvent: database.prepare('SELECT id FROM payment_events WHERE event_key = ?'),
  createEntitlement: database.prepare(`
    INSERT OR IGNORE INTO wifi_entitlements
      (id, reference_id, phone, package_name, status, starts_at, ends_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  createMovieEntitlement: database.prepare(`
    INSERT OR IGNORE INTO movie_entitlements
      (id, reference_id, phone, plan, email, status, starts_at, ends_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  findMovieEntitlementByReference: database.prepare('SELECT * FROM movie_entitlements WHERE reference_id = ?'),
  findActiveMovieEntitlement: database.prepare(`
    SELECT * FROM movie_entitlements
    WHERE (phone = ? OR email = ?) AND status = 'ACTIVE' AND ends_at > ?
    ORDER BY ends_at DESC LIMIT 1
  `),
  updateMovieEntitlement: database.prepare(`
    UPDATE movie_entitlements
    SET status = ?, starts_at = ?, ends_at = ?
    WHERE reference_id = ?
  `),
  countRecentAdUnlocks: database.prepare(`
    SELECT COUNT(*) AS count FROM movie_entitlements
    WHERE (phone = ? OR email = ?) AND reference_id LIKE 'AD-%' AND created_at > ?
  `),
  createVoucher: database.prepare(`
    INSERT INTO vouchers (code, plan, status, created_at)
    VALUES (?, ?, 'UNUSED', ?)
  `),
  findVoucher: database.prepare('SELECT * FROM vouchers WHERE code = ?'),
  upsertMovieUser: database.prepare(`
    INSERT INTO movie_users (phone, password_hash, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET password_hash = excluded.password_hash, email = excluded.email, updated_at = excluded.updated_at
  `),
  findMovieUser: database.prepare('SELECT * FROM movie_users WHERE phone = ?'),
  updateMovieUserPassword: database.prepare('UPDATE movie_users SET password_hash = ?, updated_at = ? WHERE phone = ?'),
  listVouchers: database.prepare('SELECT * FROM vouchers ORDER BY created_at DESC'),
  redeemVoucher: database.prepare(`
    UPDATE vouchers
    SET status = 'REDEEMED', redeemed_at = ?, redeemed_by_identity = ?
    WHERE code = ? AND status = 'UNUSED'
  `),
  findEntitlementByReference: database.prepare('SELECT * FROM wifi_entitlements WHERE reference_id = ?'),
  findProvisioningByEntitlement: database.prepare('SELECT * FROM wifi_provisioning WHERE entitlement_id = ? ORDER BY updated_at DESC LIMIT 1'),
  createProvisioning: database.prepare(`
    INSERT INTO wifi_provisioning
      (entitlement_id, status, provider_reference, response_payload, error_message, attempts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  createJob: database.prepare(`
    INSERT INTO jobs
      (id, employer_id, title, description, district, skills, employment_type, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listJobs: database.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC'),
  listJobsForEmployer: database.prepare('SELECT * FROM jobs WHERE employer_id = ? ORDER BY created_at DESC'),
  findJob: database.prepare('SELECT * FROM jobs WHERE id = ?'),
  createApplication: database.prepare(`
    INSERT INTO applications (id, job_id, job_seeker_id, cover_note, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  listApplicationsForJobSeeker: database.prepare('SELECT * FROM applications WHERE job_seeker_id = ? ORDER BY created_at DESC'),
  listApplicationsForEmployer: database.prepare(`
    SELECT applications.*, jobs.title, jobs.employer_id
    FROM applications JOIN jobs ON jobs.id = applications.job_id
    WHERE jobs.employer_id = ? ORDER BY applications.created_at DESC
  `),
  findApplication: database.prepare('SELECT * FROM applications WHERE id = ?'),
  upsertMatch: database.prepare(`
    INSERT INTO matches (job_id, job_seeker_id, score, reasons, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(job_id, job_seeker_id) DO UPDATE SET score = excluded.score, reasons = excluded.reasons, created_at = excluded.created_at
  `),
  listMatchesForJob: database.prepare('SELECT * FROM matches WHERE job_id = ? ORDER BY score DESC')
  ,listMatchesForJobSeeker: database.prepare('SELECT * FROM matches WHERE job_seeker_id = ? ORDER BY score DESC')
  ,countJobs: database.prepare('SELECT COUNT(*) AS count FROM jobs')
  ,countLoans: database.prepare('SELECT COUNT(*) AS count FROM loan_applications')
  ,countLoansByStatus: database.prepare('SELECT status, COUNT(*) AS count FROM loan_applications GROUP BY status')
  ,countApplications: database.prepare('SELECT COUNT(*) AS count FROM applications')
  ,countEntitlements: database.prepare('SELECT COUNT(*) AS count FROM wifi_entitlements')
  ,countProvisioned: database.prepare("SELECT COUNT(*) AS count FROM wifi_provisioning WHERE status = 'PROVISIONED'")
  ,listJobsAll: database.prepare('SELECT * FROM jobs ORDER BY created_at DESC')
  ,listApplicationsAll: database.prepare('SELECT * FROM applications ORDER BY created_at DESC')
  ,listMatchesAll: database.prepare('SELECT * FROM matches ORDER BY score DESC')
  ,listEntitlementsAll: database.prepare('SELECT * FROM wifi_entitlements ORDER BY created_at DESC')
  ,createDocument: database.prepare('INSERT INTO documents (drive_file_id, name, mime_type, size, web_view_link, related_profile_id, related_profile_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  ,listDocuments: database.prepare('SELECT * FROM documents ORDER BY created_at DESC')
  ,updateApplicationStatus: database.prepare('UPDATE applications SET status = ? WHERE id = ?')
  ,updateJobStatus: database.prepare('UPDATE jobs SET status = ? WHERE id = ?')
  ,updateSeekerVerification: database.prepare('UPDATE job_seekers SET verified_at = ? WHERE id = ?')
  ,createNotification: database.prepare('INSERT INTO notifications (recipient, channel, event, message, created_at) VALUES (?, ?, ?, ?, ?)')
  ,createConsent: database.prepare('INSERT INTO consent_records (profile_id, profile_type, consent_type, granted_at) VALUES (?, ?, ?, ?)')
  ,createDeletionRequest: database.prepare('INSERT INTO deletion_requests (profile_id, profile_type, reason, created_at) VALUES (?, ?, ?, ?)')
  ,createMovie: database.prepare(`INSERT INTO movies (id, title, year, runtime, description, genres, access, status, featured, subtitles_language, media_url, poster_url, subtitles_url, license_name, license_url, license_attribution, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ,findMovie: database.prepare('SELECT * FROM movies WHERE id = ?')
  ,listMovies: database.prepare('SELECT * FROM movies ORDER BY created_at DESC')
  ,countMovieEntitlements: database.prepare("SELECT COUNT(*) AS count FROM movie_entitlements WHERE status = 'ACTIVE' AND ends_at > ?")
  ,countMovieSubscribers: database.prepare("SELECT COUNT(DISTINCT COALESCE(NULLIF(phone, ''), email)) AS count FROM movie_entitlements WHERE COALESCE(NULLIF(phone, ''), email) IS NOT NULL AND COALESCE(NULLIF(phone, ''), email) <> ''")
  ,sumMovieRevenue: database.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE package_name LIKE 'Movies VIP%' AND status IN ('SUCCESSFUL','PENDING')")
  ,updateMovie: database.prepare(`UPDATE movies SET title = ?, year = ?, runtime = ?, description = ?, genres = ?, access = ?, status = ?, featured = ?, subtitles_language = ?, media_url = ?, poster_url = ?, subtitles_url = ?, license_name = ?, license_url = ?, license_attribution = ?, updated_at = ? WHERE id = ?`)
  ,deleteMovie: database.prepare('DELETE FROM movies WHERE id = ?')
  ,searchMovies: database.prepare(`SELECT * FROM movies WHERE status = 'published' AND (title LIKE ? OR genres LIKE ? OR description LIKE ?) ORDER BY created_at DESC`)
  ,createLoanApplication: database.prepare(`
    INSERT INTO loan_applications
      (id, full_name, email, phone, national_id, district, product, amount, term_months, purpose, monthly_income, employment_status, status, decision_note, decided_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  ,findLoanApplication: database.prepare('SELECT * FROM loan_applications WHERE id = ?')
  ,listLoanApplications: database.prepare('SELECT * FROM loan_applications ORDER BY created_at DESC')
  ,listLoanApplicationsByPhone: database.prepare('SELECT * FROM loan_applications WHERE phone = ? ORDER BY created_at DESC')
  ,updateLoanApplicationStatus: database.prepare('UPDATE loan_applications SET status = ?, decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ?')
  ,createLoanRepayment: database.prepare(`
    INSERT INTO loan_repayments (id, loan_id, reference_id, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  ,updateLoanRepaymentStatus: database.prepare('UPDATE loan_repayments SET status = ?, updated_at = ? WHERE reference_id = ?')
  ,listLoanRepayments: database.prepare('SELECT * FROM loan_repayments WHERE loan_id = ? ORDER BY created_at DESC')
};

for (const statement of [
  'ALTER TABLE users ADD COLUMN profile_id TEXT',
  'ALTER TABLE users ADD COLUMN phone TEXT',
  'ALTER TABLE users ADD COLUMN verified_at TEXT',
  'ALTER TABLE users ADD COLUMN verification_token TEXT',
  'ALTER TABLE users ADD COLUMN reset_token TEXT',
  'ALTER TABLE users ADD COLUMN reset_expires_at TEXT',
  'ALTER TABLE job_seekers ADD COLUMN verified_at TEXT',
  'ALTER TABLE employers ADD COLUMN verified_at TEXT'
]) {
  try { database.exec(statement); } catch (error) {
    if (!String(error.message).includes('duplicate column name')) throw error;
  }
}

function createUser({ email, passwordHash, role = 'admin' }) {
  statements.createUser.run(email, passwordHash, role, new Date().toISOString());
}

function updateAdminPassword({ email, passwordHash }) {
  statements.updateUserPassword.run(email, passwordHash, 'admin');
}

function getUserByEmail(email) {
  return statements.findUser.get(email);
}

function createAccount(account) {
  statements.createAccount.run(account.email, account.passwordHash, account.role, account.profileId, account.phone || null, account.verificationToken, new Date().toISOString());
}

function getUserByVerificationToken(token) { return statements.findUserByVerificationToken.get(token); }
function verifyUser(id) { statements.verifyUser.run(new Date().toISOString(), id); }
function setResetToken(email, token, expiresAt) { return statements.setResetToken.run(token, expiresAt, email); }
function getUserByResetToken(token) { return statements.findUserByResetToken.get(token); }
function resetPassword(id, passwordHash) { statements.resetPassword.run(passwordHash, id); }
function getUserByProfile(profileId, role) { return statements.findUserByProfile.get(profileId, role); }

function hasUsers() {
  return Number(statements.countUsers.get().count) > 0;
}

function createJobSeeker(profile) {
  statements.createJobSeeker.run(
    profile.id,
    profile.fullName,
    profile.email,
    profile.phone,
    profile.district,
    profile.profession,
    profile.skills,
    profile.availability,
    profile.createdAt,
    profile.accessToken
  );
}

function recordConsent(profileId, profileType, consentType) { statements.createConsent.run(profileId, profileType, consentType, new Date().toISOString()); }
function requestDeletion(profileId, profileType, reason) { statements.createDeletionRequest.run(profileId, profileType, reason || null, new Date().toISOString()); }
function updateApplicationStatus(id, status) { statements.updateApplicationStatus.run(status, id); }
function updateJobStatus(id, status) { statements.updateJobStatus.run(status, id); }
function verifyJobSeeker(id) { statements.updateSeekerVerification.run(new Date().toISOString(), id); }
function queueNotification(notification) { statements.createNotification.run(notification.recipient, notification.channel, notification.event, notification.message, new Date().toISOString()); }
function createDocument(document) { statements.createDocument.run(document.driveFileId, document.name, document.mimeType, document.size || null, document.webViewLink || null, document.relatedProfileId || null, document.relatedProfileType || null, new Date().toISOString()); }
function listDocuments() { return statements.listDocuments.all().map((row) => ({ id: row.id, driveFileId: row.drive_file_id, name: row.name, mimeType: row.mime_type, size: row.size, webViewLink: row.web_view_link, relatedProfileId: row.related_profile_id, relatedProfileType: row.related_profile_type, createdAt: row.created_at })); }

function createEmployer(employer) {
  statements.createEmployer.run(
    employer.id,
    employer.companyName,
    employer.contactName,
    employer.email,
    employer.phone,
    employer.district,
    employer.hiringNeed,
    employer.companyType,
    employer.createdAt,
    employer.accessToken
  );
}

function getJobSeekerByToken(token) {
  return statements.findJobSeekerByToken.get(token);
}
function getJobSeekerById(id) { return statements.findJobSeekerById.get(id); }

function getEmployerByToken(token) {
  return statements.findEmployerByToken.get(token);
}
function getEmployerById(id) { return statements.findEmployerById.get(id); }

function getRecords() {
  return {
    jobSeekers: statements.listJobSeekers.all().map((row) => ({
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      district: row.district,
      profession: row.profession,
      skills: row.skills,
      availability: row.availability,
      createdAt: row.created_at
    })),
    employers: statements.listEmployers.all().map((row) => ({
      id: row.id,
      companyName: row.company_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      district: row.district,
      hiringNeed: row.hiring_need,
      companyType: row.company_type,
      createdAt: row.created_at
    }))
  };
}

function getAdminOverview() {
  const records = getRecords();
  return {
    ...records,
    jobs: statements.listJobsAll.all().map((row) => ({ id: row.id, employerId: row.employer_id, title: row.title, district: row.district, status: row.status, createdAt: row.created_at })),
    applications: statements.listApplicationsAll.all().map((row) => ({ id: row.id, jobId: row.job_id, jobSeekerId: row.job_seeker_id, status: row.status, createdAt: row.created_at })),
    matches: statements.listMatchesAll.all().map((row) => ({ id: row.id, jobId: row.job_id, jobSeekerId: row.job_seeker_id, score: row.score, reasons: JSON.parse(row.reasons) })),
    entitlements: statements.listEntitlementsAll.all().map((row) => ({ id: row.id, referenceId: row.reference_id, phone: row.phone, packageName: row.package_name, status: row.status, startsAt: row.starts_at, endsAt: row.ends_at })),
    totals: {
      jobSeekers: records.jobSeekers.length,
      employers: records.employers.length,
      jobs: Number(statements.countJobs.get().count),
      loans: Number(statements.countLoans.get().count),
      loansByStatus: Object.fromEntries(statements.countLoansByStatus.all().map((row) => [row.status, Number(row.count)])),
      applications: Number(statements.countApplications.get().count),
      entitlements: Number(statements.countEntitlements.get().count),
      provisioned: Number(statements.countProvisioned.get().count)
    }
  };
}

function createPayment(payment) {
  statements.createPayment.run(
    payment.referenceId,
    payment.externalId,
    payment.packageName,
    payment.amount,
    payment.phone,
    payment.currency,
    payment.status,
    payment.callbackUrl,
    payment.createdAt,
    payment.gateway || 'mtn',
    payment.providerReference || null
  );
}

function getPayment(referenceId) {
  return parsePayment(statements.findPayment.get(referenceId));
}

function getPaymentByExternalId(externalId) {
  return parsePayment(statements.findPaymentByExternalId.get(externalId));
}

function listPayments() {
  return statements.listPayments.all().map(parsePayment);
}

function updatePayment(referenceId, { status, checkedAt, updatedAt, providerPayload }) {
  statements.updatePayment.run(
    status,
    checkedAt || null,
    updatedAt || null,
    providerPayload ? JSON.stringify(providerPayload) : null,
    referenceId
  );
  return getPayment(referenceId);
}

function recordPaymentEvent({ referenceId, eventKey, status, payload }) {
  if (statements.findPaymentEvent.get(eventKey)) return false;
  statements.createPaymentEvent.run(referenceId, eventKey, status, JSON.stringify(payload || {}), new Date().toISOString());
  return true;
}

function createWifiEntitlement({ id, referenceId, phone, packageName, startsAt, endsAt }) {
  statements.createEntitlement.run(id, referenceId, phone, packageName, 'ACTIVE', startsAt, endsAt, new Date().toISOString());
  const entitlement = statements.findEntitlementByReference.get(referenceId);
  if (entitlement) {
    statements.createProvisioning.run(entitlement.id, 'PENDING', null, null, null, 0, new Date().toISOString());
  }
  return entitlement;
}

function getWifiEntitlement(referenceId) {
  const entitlement = statements.findEntitlementByReference.get(referenceId);
  if (!entitlement) return null;
  const provisioning = statements.findProvisioningByEntitlement.get(entitlement.id);
  let access = null;
  if (provisioning?.response_payload) {
    try {
      const payload = JSON.parse(provisioning.response_payload);
      if (payload.username && payload.password) access = { username: payload.username, password: payload.password, profile: payload.profile || null };
    } catch {
      access = null;
    }
  }
  return {
    id: entitlement.id,
    referenceId: entitlement.reference_id,
    phone: entitlement.phone,
    packageName: entitlement.package_name,
    status: entitlement.status,
    startsAt: entitlement.starts_at,
    endsAt: entitlement.ends_at,
    provisioning: provisioning ? { status: provisioning.status, providerReference: provisioning.provider_reference, updatedAt: provisioning.updated_at } : null,
    access
  };
}

function parseMovieEntitlement(row) {
  if (!row) return null;
  return {
    id: row.id,
    referenceId: row.reference_id,
    phone: row.phone,
    plan: row.plan,
    email: row.email || null,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at
  };
}

function createMovieEntitlement({ id, referenceId, phone, plan, email = null, status = 'PENDING', startsAt, endsAt }) {
  statements.createMovieEntitlement.run(id, referenceId, phone || '', plan, email || null, status, startsAt, endsAt, new Date().toISOString());
  return getMovieEntitlement(referenceId);
}

function getMovieEntitlement(referenceId) {
  return parseMovieEntitlement(statements.findMovieEntitlementByReference.get(referenceId));
}

function getActiveMovieEntitlement(identity, now = new Date().toISOString()) {
  if (!identity) return null;
  return parseMovieEntitlement(statements.findActiveMovieEntitlement.get(identity, identity, now));
}

function countRecentAdUnlocks(identity, since) {
  if (!identity) return 0;
  return Number(statements.countRecentAdUnlocks.get(identity, identity, since).count);
}

function parseMovie(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    year: row.year,
    runtime: row.runtime,
    description: row.description,
    genres: row.genres,
    access: row.access,
    status: row.status,
    featured: Boolean(row.featured),
    subtitlesLanguage: row.subtitles_language || 'en',
    mediaUrl: row.media_url,
    posterUrl: row.poster_url || null,
    subtitlesUrl: row.subtitles_url || null,
    license: {
      name: row.license_name,
      url: row.license_url,
      attribution: row.license_attribution
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createMovie(movie) {
  statements.createMovie.run(
    movie.id,
    movie.title,
    movie.year,
    movie.runtime,
    movie.description,
    movie.genres,
    movie.access,
    movie.status,
    movie.featured ? 1 : 0,
    movie.subtitlesLanguage || 'en',
    movie.mediaUrl,
    movie.posterUrl || null,
    movie.subtitlesUrl || null,
    movie.license?.name || '',
    movie.license?.url || '',
    movie.license?.attribution || '',
    movie.createdAt,
    movie.updatedAt
  );
  return getMovie(movie.id);
}

function getMovie(id) {
  return parseMovie(statements.findMovie.get(id));
}

function listMovies(options = {}) {
  const { status } = options;
  const rows = status ? statements.listMovies.all().filter((row) => row.status === status) : statements.listMovies.all();
  return rows.map(parseMovie);
}

function updateMovie(id, updates) {
  const existing = getMovie(id);
  if (!existing) return null;
  const updated = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  statements.updateMovie.run(
    updated.title,
    updated.year,
    updated.runtime,
    updated.description,
    updated.genres,
    updated.access,
    updated.status,
    updated.featured ? 1 : 0,
    updated.subtitlesLanguage || 'en',
    updated.mediaUrl,
    updated.posterUrl || null,
    updated.subtitlesUrl || null,
    updated.license?.name || '',
    updated.license?.url || '',
    updated.license?.attribution || '',
    updated.updatedAt,
    id
  );
  return getMovie(id);
}

function deleteMovie(id) {
  const result = statements.deleteMovie.run(id);
  return Number(result.changes) > 0;
}

function searchMovies(query) {
  const term = `%${query}%`;
  return statements.searchMovies.all(term, term, term).map(parseMovie);
}

function createVoucher({ code, plan }) {
  statements.createVoucher.run(code, plan, new Date().toISOString());
  return getVoucher(code);
}

function getVoucher(code) {
  const row = statements.findVoucher.get(String(code || '').trim().toUpperCase());
  if (!row) return null;
  return { code: row.code, plan: row.plan, status: row.status, createdAt: row.created_at, redeemedAt: row.redeemed_at, redeemedByIdentity: row.redeemed_by_identity };
}

function listVouchers() {
  return statements.listVouchers.all().map((row) => ({ code: row.code, plan: row.plan, status: row.status, createdAt: row.created_at, redeemedAt: row.redeemed_at, redeemedByIdentity: row.redeemed_by_identity }));
}

function redeemVoucher(code, identity) {
  const result = statements.redeemVoucher.run(new Date().toISOString(), identity, String(code || '').trim().toUpperCase());
  return Number(result.changes) > 0;
}

function updateMovieEntitlement(referenceId, { status, startsAt, endsAt }) {
  const existing = getMovieEntitlement(referenceId);
  if (!existing) return null;
  statements.updateMovieEntitlement.run(status, startsAt || existing.startsAt, endsAt || existing.endsAt, referenceId);
  return getMovieEntitlement(referenceId);
}

function getMovieDashboardStats() {
  const now = new Date().toISOString();
  return {
    totalSubscribers: Number(statements.countMovieSubscribers.get().count),
    activeVipPasses: Number(statements.countMovieEntitlements.get(now).count),
    totalRevenue: Number(statements.sumMovieRevenue.get().total),
    totalTitles: Number(statements.listMovies.all().length)
  };
}

function recordProvisioningAttempt(entitlementId, result) {
  statements.createProvisioning.run(
    entitlementId,
    result.status,
    result.providerReference || null,
    result.payload ? JSON.stringify(result.payload) : null,
    result.errorMessage || null,
    result.attempts || 1,
    new Date().toISOString()
  );
}

function createJob(job) {
  statements.createJob.run(job.id, job.employerId, job.title, job.description, job.district, job.skills, job.employmentType, 'OPEN', job.createdAt);
  return getJob(job.id);
}

function getJob(id) {
  const row = statements.findJob.get(id);
  return row && { id: row.id, employerId: row.employer_id, title: row.title, description: row.description, district: row.district, skills: row.skills, employmentType: row.employment_type, status: row.status, createdAt: row.created_at };
}

function listJobs() {
  return statements.listJobs.all('OPEN').map((row) => ({ id: row.id, employerId: row.employer_id, title: row.title, description: row.description, district: row.district, skills: row.skills, employmentType: row.employment_type, status: row.status, createdAt: row.created_at }));
}

function listJobsForEmployer(employerId) {
  return statements.listJobsForEmployer.all(employerId).map((row) => ({ id: row.id, employerId: row.employer_id, title: row.title, description: row.description, district: row.district, skills: row.skills, employmentType: row.employment_type, status: row.status, createdAt: row.created_at }));
}

function createApplication(application) {
  statements.createApplication.run(application.id, application.jobId, application.jobSeekerId, application.coverNote, 'SUBMITTED', application.createdAt);
}

function listApplicationsForJobSeeker(jobSeekerId) {
  return statements.listApplicationsForJobSeeker.all(jobSeekerId);
}

function listApplicationsForEmployer(employerId) {
  return statements.listApplicationsForEmployer.all(employerId);
}

function getApplication(id) { return statements.findApplication.get(id); }

function saveMatch(match) {
  statements.upsertMatch.run(match.jobId, match.jobSeekerId, match.score, JSON.stringify(match.reasons), new Date().toISOString());
}

function listMatchesForJob(jobId) {
  return statements.listMatchesForJob.all(jobId).map((row) => ({ ...row, reasons: JSON.parse(row.reasons) }));
}

function listMatchesForJobSeeker(jobSeekerId) {
  return statements.listMatchesForJobSeeker.all(jobSeekerId).map((row) => ({ ...row, reasons: JSON.parse(row.reasons) }));
}

function parseLoanApplication(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    nationalId: row.national_id,
    district: row.district,
    product: row.product,
    amount: Number(row.amount),
    termMonths: Number(row.term_months),
    purpose: row.purpose,
    monthlyIncome: Number(row.monthly_income),
    employmentStatus: row.employment_status,
    status: row.status,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createLoanApplication(application) {
  statements.createLoanApplication.run(
    application.id,
    application.fullName,
    application.email,
    application.phone,
    application.nationalId || null,
    application.district,
    application.product,
    application.amount,
    application.termMonths,
    application.purpose,
    application.monthlyIncome,
    application.employmentStatus,
    application.status || 'SUBMITTED',
    application.decisionNote || null,
    application.decidedAt || null,
    application.createdAt,
    application.updatedAt || application.createdAt
  );
  return getLoanApplication(application.id);
}

function getLoanApplication(id) {
  return parseLoanApplication(statements.findLoanApplication.get(id));
}

function listLoanApplications() {
  return statements.listLoanApplications.all().map(parseLoanApplication);
}

function listLoanApplicationsByPhone(phone) {
  return statements.listLoanApplicationsByPhone.all(phone).map(parseLoanApplication);
}

function updateLoanApplicationStatus(id, status, decisionNote = null) {
  const now = new Date().toISOString();
  statements.updateLoanApplicationStatus.run(status, decisionNote, ['APPROVED', 'REJECTED', 'DISBURSED', 'REPAID'].includes(status) ? now : null, now, id);
  return getLoanApplication(id);
}

function createLoanRepayment({ id, loanId, referenceId, amount, status = 'PENDING', createdAt }) {
  const now = createdAt || new Date().toISOString();
  statements.createLoanRepayment.run(id, loanId, referenceId, amount, status, now, now);
}

function updateLoanRepaymentStatus(referenceId, status) {
  statements.updateLoanRepaymentStatus.run(status, new Date().toISOString(), referenceId);
}

function listLoanRepayments(loanId) {
  return statements.listLoanRepayments.all(loanId);
}

module.exports = {
  getAdminOverview,
  getApplication,
  createEmployer,
  createDocument,
  createAccount,
  createJobSeeker,
  createPayment,
  createApplication,
  createJob,
  createWifiEntitlement,
  createUser,
  getPayment,
  getPaymentByExternalId,
  getEmployerByToken,
  getEmployerById,
  getJob,
  getJobSeekerByToken,
  getJobSeekerById,
  getWifiEntitlement,
  createMovieEntitlement,
  getMovieEntitlement,
  getActiveMovieEntitlement,
  getMovieDashboardStats,
  updateMovieEntitlement,
  createMovie,
  getMovie,
  listMovies,
  updateMovie,
  deleteMovie,
  searchMovies,
  countRecentAdUnlocks,
  createVoucher,
  getVoucher,
  listVouchers,
  redeemVoucher,
  getRecords,
  getUserByEmail,
  getUserByProfile,
  getUserByResetToken,
  getUserByVerificationToken,
  hasUsers,
  listPayments,
  listApplicationsForEmployer,
  listDocuments,
  listApplicationsForJobSeeker,
  listJobs,
  listJobsForEmployer,
  queueNotification,
  recordConsent,
  requestDeletion,
  resetPassword,
  setResetToken,
  updateApplicationStatus,
  updateJobStatus,
  verifyJobSeeker,
  verifyUser,
  listMatchesForJob,
  listMatchesForJobSeeker,
  recordPaymentEvent,
  recordProvisioningAttempt,
  saveMatch,
  updateAdminPassword,
  updatePayment,
  createLoanApplication,
  getLoanApplication,
  listLoanApplications,
  listLoanApplicationsByPhone,
  updateLoanApplicationStatus,
  createLoanRepayment,
  updateLoanRepaymentStatus,
  listLoanRepayments
};
