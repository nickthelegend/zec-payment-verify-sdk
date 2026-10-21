#!/usr/bin/env node
// Verify API only (no paywall): POST /api/verify, GET /api/health. For the dashboard.
// Env: ZPV_PORT (default 8403), ZPV_CORS (default http://localhost:5180), ZPV_LWD_URL, or ZPV_LWD_URLS + ZPV_LWD_QUORUM
// to cross-check every zcash verdict against several lightwalletd endpoints.
import { createPaywall } from './server.js';

const port = Number(process.env.ZPV_PORT ?? 8403);
createPaywall({ payTo: '', uivk: '', prices: {}, content: () => null, corsOrigins: (process.env.ZPV_CORS ?? 'http://localhost:5180').split(','), lwdUrl: process.env.ZPV_LWD_URL }).listen(port, '127.0.0.1', () =>
  console.log(`zpv verify API on http://127.0.0.1:${port}/api/verify`),
);
