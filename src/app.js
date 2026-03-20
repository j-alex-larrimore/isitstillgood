// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const session = require('express-session');
require('dotenv').config();

const app = express();

// ─── Security & Logging ──────────────────────────────────────────────────────
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5500',
  ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL] : []),
  // Always allow both www and non-www variants automatically
  ...(process.env.CLIENT_URL ? [
    process.env.CLIENT_URL.replace('https://www.', 'https://'),
    process.env.CLIENT_URL.replace('https://', 'https://www.'),
  ] : []),
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));

// ─── Body & Cookie Parsing ───────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Session (Passport Google OAuth needs this) ──────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 10,
  },
}));

// ─── Passport ────────────────────────────────────────────────────────────────
const passport = require('./middleware/passport');
app.use(passport.initialize());
app.use(passport.session());

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/users',   require('./routes/users'));
app.use('/api/media',   require('./routes/media'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/feed',    require('./routes/feed'));
app.use('/api/lists',   require('./routes/lists'));
app.use('/api/admin',   require('./routes/admin'));
app.use('/api/requests',require('./routes/requests'));
app.use('/api/invites', require('./routes/invites'));  // email invite system

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ─── Global error handler ────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

module.exports = app;
