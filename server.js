require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- DB (optional but recommended) ---
const { Pool } = require('pg');
const HAS_DB = !!process.env.DATABASE_URL;
const pool = HAS_DB
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Render PG uses SSL
    })
  : null;

async function initDb() {
  if (!HAS_DB) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      app_number TEXT UNIQUE NOT NULL,
      firstname TEXT NOT NULL,
      middlename TEXT,
      lastname TEXT NOT NULL,
      email TEXT NOT NULL,
      dob DATE,
      nationality TEXT,
      passport TEXT,
      passport_file_name TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('🗄️  DB ready (applications table ensured)');
}

// Helpers to talk to DB (or fallback to memory)
let memoryApplications = []; // used only if no DATABASE_URL

async function dbInsertApplication(app) {
  if (!HAS_DB) {
    memoryApplications.push(app);
    return;
  }
  const q = `
    INSERT INTO applications
      (app_number, firstname, middlename, lastname, email, dob, nationality, passport, passport_file_name, status, submitted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
    ON CONFLICT (app_number) DO NOTHING
  `;
  const params = [
    app.appNumber,
    app.firstname,
    app.middlename || null,
    app.lastname,
    app.email,
    app.dob || null,
    app.nationality || null,
    app.passport || null,
    app.passportFileName || null,
    app.status || 'Pending Review',
  ];
  await pool.query(q, params);
}

async function dbListApplications() {
  if (!HAS_DB) {
    // shape to match DB rows
    return memoryApplications.map(a => ({
      app_number: a.appNumber,
      firstname: a.firstname,
      middlename: a.middlename || null,
      lastname: a.lastname,
      email: a.email,
      dob: a.dob || null,
      nationality: a.nationality || null,
      passport: a.passport || null,
      passport_file_name: a.passportFileName || '',
      status: a.status,
      submitted_at: a.submittedAt || new Date().toISOString(),
    }));
  }
  const { rows } = await pool.query(
    `SELECT app_number, firstname, middlename, lastname, email, dob, nationality, passport, passport_file_name, status, submitted_at
     FROM applications
     ORDER BY submitted_at DESC`
  );
  return rows;
}

async function dbUpdateStatus(appNumber, status) {
  if (!HAS_DB) {
    const f = memoryApplications.find(a => a.appNumber === appNumber);
    if (!f) return false;
    f.status = status;
    return true;
  }
  const { rowCount } = await pool.query(
    `UPDATE applications SET status = $1 WHERE app_number = $2`,
    [status, appNumber]
  );
  return rowCount > 0;
}

async function dbFindForTracking(appNumber, lastName) {
  if (!HAS_DB) {
    return memoryApplications.find(
      a =>
        String(a.appNumber).toUpperCase() === String(appNumber).toUpperCase() &&
        String(a.lastname).toLowerCase() === String(lastName).toLowerCase()
    );
  }
  const { rows } = await pool.query(
    `SELECT firstname, lastname, status
       FROM applications
      WHERE UPPER(app_number) = UPPER($1)
        AND LOWER(lastname) = LOWER($2)
      LIMIT 1`,
    [appNumber, lastName]
  );
  return rows[0] || null;
}

// --- App setup ---
const app = express();
const PORT = process.env.PORT || 5050;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REQUIRE_PAYMENT = process.env.REQUIRE_PAYMENT !== 'false'; // default: true

// Track paid applications (via Stripe metadata + webhook)
const paidApps = new Set();

// Ensure uploads dir exists (ephemeral on Render; OK for now)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Trust Render’s proxy (for secure cookies, HTTPS)
app.set('trust proxy', 1);

// Security headers (allow Stripe, inline CSS/JS, Google Fonts)
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
        "frame-src": ["'self'", "https://js.stripe.com"],
        "connect-src": ["'self'", "https://api.stripe.com"],
        "img-src": ["'self'", "data:"]
      }
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" }
  })
);

// Enforce HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// Sessions (secure cookie in prod)
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// === Multer setup with file size/type limits ===
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${unique}${ext}`);
  }
});
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const allowedMime = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (allowedMime.has(file.mimetype)) return cb(null, true);
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only PDF, JPG, and PNG files are allowed.'));
  }
});

// === Rate Limiters ===
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many uploads, please try again later.' }
});
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Try again later.' }
});
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many payment requests. Please slow down.' }
});
const trackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many track requests. Please try again later.' }
});

// Health check
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Admin auth
function isAuthenticated(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(403).json({ message: 'Forbidden – Admin not logged in' });
}

// Protect dashboard
app.get('/dashboard.html', (req, res) => {
  if (req.session && req.session.loggedIn) {
    return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  }
  return res.redirect('/admin.html');
});

// Home
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Stripe Checkout Session
 * NOTE: Global parsers mounted AFTER webhook;
 * use route-specific parsers here.
 */
app.post(
  '/create-checkout-session',
  checkoutLimiter,
  express.json(),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const { email, appNumber } = req.body || {};
      if (!email) return res.status(400).json({ error: 'Email is required' });

      const sessionObj = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        customer_email: email,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Liberia Visa Application Fee',
              description: 'Required for processing your visa application'
            },
            unit_amount: 15000 // $150
          },
          quantity: 1
        }],
        metadata: appNumber ? { appNumber } : {},
        success_url: `${BASE_URL}/success.html`,
        cancel_url: `${BASE_URL}/application.html`
      });

      res.json({ url: sessionObj.url });
    } catch (err) {
      console.error('⚠️ Stripe error:', err);
      res.status(500).json({ error: 'Failed to create payment session' });
    }
  }
);

// Stripe Webhook
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.sendStatus(400);
    }

    if (event.type === 'checkout.session.completed') {
      const sessionObj = event.data.object;
      const meta = sessionObj.metadata || {};
      if (meta.appNumber) {
        paidApps.add(String(meta.appNumber).toUpperCase());
        console.log(`💸 Marked paid: ${meta.appNumber}`);
      } else {
        console.warn('checkout.session.completed without appNumber metadata');
      }
    }

    res.sendStatus(200);
  }
);

// Global parsers AFTER webhook
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Submit application
app.post('/submit', uploadLimiter, upload.single('passportFile'), async (req, res) => {
  try {
    const { firstname, middlename, lastname, email, dob, nationality, passport, appNumber } = req.body;

    if (!firstname || !lastname || !email || !appNumber) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    if (REQUIRE_PAYMENT && !paidApps.has(String(appNumber).toUpperCase())) {
      return res.status(402).json({ message: 'Payment required before submission' });
    }

    const passportFileName = req.file ? req.file.filename : '';

    // Persist
    await dbInsertApplication({
      firstname,
      middlename,
      lastname,
      email,
      dob: dob || null,
      nationality,
      passport,
      appNumber,
      passportFileName,
      status: 'Pending Review',
      submittedAt: new Date().toISOString(),
    });

    // Email confirmation
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USERNAME, pass: process.env.EMAIL_PASSWORD }
    });

    await transporter.sendMail({
      from: `EasyVisa Liberia <${process.env.EMAIL_USERNAME}>`,
      to: email,
      subject: 'EasyVisa Liberia – Application Received',
      text: `Dear ${firstname},

Your application has been received.

Application Number: ${appNumber}

Regards,
EasyVisa Liberia`
    });

    res.status(200).json({ message: 'Application saved and email sent' });
  } catch (err) {
    console.error('🔥 Submit error:', err);
    res.status(500).json({ message: 'Submission failed' });
  }
});

// Admin login/logout
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

app.post('/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.loggedIn = true;
    return res.sendStatus(200);
  }
  return res.status(401).json({ message: 'Unauthorized' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ message: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.status(200).json({ message: 'Logged out' });
  });
});

// Admin endpoints
app.get('/admin/applications', isAuthenticated, async (_req, res) => {
  try {
    const rows = await dbListApplications();
    // sanitize & normalize keys for the front-end JS
    const sanitized = rows.map(r => ({
      appNumber: r.app_number,
      firstname: r.firstname,
      lastname: r.lastname,
      email: r.email,
      nationality: r.nationality,
      passport: r.passport,
      status: r.status,
      passportFileName: r.passport_file_name || '',
      submittedAt: r.submitted_at,
    }));
    res.json(sanitized);
  } catch (e) {
    console.error('Admin list error:', e);
    res.status(500).json({ message: 'Failed to load applications' });
  }
});

app.post('/admin/update-status', isAuthenticated, async (req, res) => {
  const { appNumber, status } = req.body || {};
  try {
    const ok = await dbUpdateStatus(appNumber, status);
    if (!ok) return res.status(404).json({ message: 'Application not found' });
    return res.sendStatus(200);
  } catch (e) {
    console.error('Update status error:', e);
    return res.status(500).json({ message: 'Failed to update status' });
  }
});

// Tracking
app.post('/track', trackLimiter, async (req, res) => {
  const { appNumber, lastName } = req.body || {};
  if (!appNumber || !lastName) {
    return res.status(400).json({ message: 'Missing tracking fields' });
  }

  try {
    const found = await dbFindForTracking(appNumber, lastName);
    if (found) {
      return res.status(200).json({
        status: found.status,
        name: `${found.firstname} ${found.lastname}`
      });
    }
    return res.status(404).json({ message: 'Application not found' });
  } catch (e) {
    console.error('Track error:', e);
    return res.status(500).json({ message: 'Tracking failed' });
  }
});

// Multer error handler
app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File too large. Max 5MB allowed.' });
    }
    return res.status(400).json({ message: err.message || 'Invalid file upload.' });
  }
  return next(err);
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1y', etag: true }));
app.use('/uploads', express.static(UPLOAD_DIR));

// 404
app.use((_req, res) => res.status(404).send('Page not found'));

// Start server
app.listen(PORT, async () => {
  try {
    await initDb();
  } catch (e) {
    console.error('DB init error (continuing in memory mode):', e.message);
  }
  console.log(`✅ EasyVisa server running at ${BASE_URL} (port ${PORT})`);
});