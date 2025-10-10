require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const session = require('express-session');
const helmet = require('helmet');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 5050;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REQUIRE_PAYMENT = process.env.REQUIRE_PAYMENT !== 'false'; // default: true

// Keep track of paid applications via Stripe metadata -> webhook
const paidApps = new Set();

// Ensure uploads dir exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Trust Render’s proxy (needed for secure cookies, protocol checks)
app.set('trust proxy', 1);

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "https://js.stripe.com"],
        "frame-src": ["'self'", "https://js.stripe.com"],
        "connect-src": ["'self'", "https://api.stripe.com"],
        "img-src": ["'self'", "data:"],
      },
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  })
);

// Optional: force HTTPS in production
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
    secure: process.env.NODE_ENV === 'production' // requires HTTPS
  }
}));

// Multer (file uploads)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${unique}${ext}`);
  }
});
const upload = multer({ storage });

// Body parsers (JSON, forms) — NOTE: Stripe webhook uses raw parser below
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check for Render
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Auth gate for admin APIs
function isAuthenticated(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(403).json({ message: 'Forbidden – Admin not logged in' });
}

// Protect /dashboard.html
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

// Create Stripe Checkout Session
// Accepts email and (recommended) appNumber — we store appNumber in session metadata
app.post('/create-checkout-session', async (req, res) => {
  const { email, appNumber } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
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
      metadata: appNumber ? { appNumber } : {}, // helps the webhook link payment -> application
      success_url: `${BASE_URL}/success.html`,
      cancel_url: `${BASE_URL}/application.html`
    });

    res.json({ url: sessionObj.url });
  } catch (err) {
    console.error('⚠️ Stripe error:', err);
    res.status(500).json({ error: 'Failed to create payment session' });
  }
});

/**
 * Stripe Webhook
 * IMPORTANT: must use raw body for signature verification.
 * In Stripe Dashboard, set endpoint to: https://YOUR_DOMAIN/api/stripe/webhook
 * Subscribe at least to: checkout.session.completed
 */
app.post('/api/stripe/webhook',
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

    // Handle successful checkout
    if (event.type === 'checkout.session.completed') {
      const sessionObj = event.data.object;
      const meta = sessionObj.metadata || {};
      if (meta.appNumber) {
        paidApps.add(meta.appNumber.toUpperCase());
        console.log(`💸 Marked paid: ${meta.appNumber}`);
      } else {
        console.warn('checkout.session.completed without appNumber metadata');
      }
    }

    res.sendStatus(200);
  }
);

// IMPORTANT: after the webhook route, restore JSON parser for remaining routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Submit visa application (requires payment if REQUIRE_PAYMENT=true)
let applications = []; // In-memory (replace with DB for production)

app.post('/submit', upload.single('passportFile'), async (req, res) => {
  try {
    const {
      firstname, middlename, lastname, email, dob,
      nationality, passport, appNumber
    } = req.body;

    if (!firstname || !lastname || !email || !appNumber) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    if (REQUIRE_PAYMENT && !paidApps.has(String(appNumber).toUpperCase())) {
      return res.status(402).json({ message: 'Payment required before submission' });
    }

    const passportFileName = req.file ? req.file.filename : '';

    applications.push({
      firstname,
      middlename,
      lastname,
      email,
      dob,
      nationality,
      passport,
      appNumber,
      passportFileName,
      status: 'Pending Review'
    });

    // Email confirmation (use an App Password if Gmail)
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USERNAME,
        pass: process.env.EMAIL_PASSWORD
      }
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

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
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
app.get('/admin/applications', isAuthenticated, (_req, res) => {
  const sanitized = applications.map(app => ({
    appNumber: app.appNumber,
    firstname: app.firstname,
    lastname: app.lastname,
    email: app.email,
    nationality: app.nationality,
    passport: app.passport,
    status: app.status,
    passportFileName: app.passportFileName || ''
  }));
  res.json(sanitized);
});

app.post('/admin/update-status', isAuthenticated, (req, res) => {
  const { appNumber, status } = req.body;
  const found = applications.find(a => a.appNumber === appNumber);
  if (!found) return res.status(404).json({ message: 'Application not found' });
  found.status = status;
  return res.sendStatus(200);
});

// Tracking
app.post('/track', (req, res) => {
  const { appNumber, lastName } = req.body;
  if (!appNumber || !lastName) {
    return res.status(400).json({ message: 'Missing tracking fields' });
  }

  const found = applications.find(app =>
    String(app.appNumber).toUpperCase() === String(appNumber).toUpperCase() &&
    String(app.lastname).toLowerCase() === String(lastName).toLowerCase()
  );

  if (found) {
    return res.status(200).json({
      status: found.status,
      name: `${found.firstname} ${found.lastname}`
    });
  }
  return res.status(404).json({ message: 'Application not found' });
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  // cache static assets; keep HTML un-cached on front-end if needed
  maxAge: '1y',
  etag: true
}));
app.use('/uploads', express.static(UPLOAD_DIR));

// 404
app.use((_req, res) => res.status(404).send('Page not found'));

// Start server
app.listen(PORT, () => {
  console.log(`✅ EasyVisa server running at ${BASE_URL} (port ${PORT})`);
});