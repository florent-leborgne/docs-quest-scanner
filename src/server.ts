import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './routes/api.js';
import { loadEnv } from './env.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3847', 10);

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(resolve(__dirname, 'public')));

// API routes
app.use('/api', apiRouter);

// SPA fallback (Express 5 requires named wildcard)
app.get('/{*path}', (_req, res) => {
  res.sendFile(resolve(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PR Docs Triage running at http://localhost:${PORT}`);
});
