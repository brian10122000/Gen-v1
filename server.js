const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const DATA_DIR = './data';
const CONFIG_FILE = `${DATA_DIR}/config.json`;
const STOCK_FILE = `${DATA_DIR}/stock.json`;
const LICENSES_FILE = `${DATA_DIR}/licenses.json`;
const LOGS_FILE = `${DATA_DIR}/logs.json`;
const BUTTONS_FILE = `${DATA_DIR}/buttons.json`;

function loadData(file) { if (!fs.existsSync(file)) return {}; return JSON.parse(fs.readFileSync(file, 'utf8')); }
function saveData(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}
function addLog(action, userId, details) {
  const logs = loadData(LOGS_FILE);
  if (!logs.logs) logs.logs = [];
  logs.logs.unshift({ timestamp: new Date().toISOString(), action, userId: userId || 'PANEL', details });
  if (logs.logs.length > 500) logs.logs = logs.logs.slice(0, 500);
  saveData(LOGS_FILE, logs);
}

const config = loadData(CONFIG_FILE);
const PORT = process.env.PORT || config.panelPort || 3000;
const SECRET = config.panelSecret || 'changeme';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SECRET + '_sess', resave: false, saveUninitialized: false, cookie: { maxAge: 3600000 } }));

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.status(401).json({ error: 'Non authentifié' });
}

// AUTH
app.post('/api/login', (req, res) => {
  const cfg = loadData(CONFIG_FILE);
  if (req.body.password === cfg.panelSecret) { req.session.authenticated = true; res.json({ success: true }); }
  else res.status(401).json({ error: 'Incorrect' });
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/me', (req, res) => res.json({ authenticated: !!req.session?.authenticated }));

// STOCK
app.get('/api/stock', requireAuth, (req, res) => { const d = loadData(STOCK_FILE); res.json(d.categories || {}); });
app.post('/api/stock/category', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const d = loadData(STOCK_FILE);
  if (!d.categories) d.categories = {};
  if (d.categories[name]) return res.status(400).json({ error: 'Déjà existant' });
  d.categories[name] = [];
  saveData(STOCK_FILE, d);
  addLog('CREATE_CATEGORY', null, `Cat: ${name}`);
  res.json({ success: true });
});
app.delete('/api/stock/category/:name', requireAuth, (req, res) => {
  const d = loadData(STOCK_FILE);
  delete d.categories[req.params.name];
  saveData(STOCK_FILE, d);
  addLog('DELETE_CATEGORY', null, `Cat: ${req.params.name}`);
  res.json({ success: true });
});
app.post('/api/stock/:category/items', requireAuth, async (req, res) => {
  const { category } = req.params;
  const { items } = req.body;
  if (!items) return res.status(400).json({ error: 'Items requis' });
  const d = loadData(STOCK_FILE);
  if (!d.categories) d.categories = {};
  if (!d.categories[category]) d.categories[category] = [];
  const parsed = items.split('\n').map(i => i.trim()).filter(Boolean);
  d.categories[category].push(...parsed);
  saveData(STOCK_FILE, d);
  addLog('ADD_STOCK', null, `Cat: ${category} | +${parsed.length}`);
  try { const { client, notifyStockAdded } = require('./bot.js'); if (client.isReady()) await notifyStockAdded(category, parsed.length, 'Panneau Admin'); } catch(e) {}
  res.json({ success: true, added: parsed.length, total: d.categories[category].length });
});
app.delete('/api/stock/:category/items', requireAuth, (req, res) => {
  const d = loadData(STOCK_FILE);
  if (d.categories?.[req.params.category]) d.categories[req.params.category] = [];
  saveData(STOCK_FILE, d);
  addLog('CLEAR_STOCK', null, `Cat: ${req.params.category}`);
  res.json({ success: true });
});

// PANELS (boutons custom)
app.get('/api/panels', requireAuth, (req, res) => {
  const d = loadData(BUTTONS_FILE);
  res.json({ panels: d.panels || [] });
});
app.post('/api/panels', requireAuth, (req, res) => {
  const panel = req.body;
  if (!panel.name) return res.status(400).json({ error: 'Nom requis' });
  const d = loadData(BUTTONS_FILE);
  if (!d.panels) d.panels = [];
  if (d.panels.find(p => p.name === panel.name)) return res.status(400).json({ error: 'Panel déjà existant' });
  d.panels.push(panel);
  saveData(BUTTONS_FILE, d);
  addLog('CREATE_PANEL', null, `Panel: ${panel.name}`);
  res.json({ success: true });
});
app.put('/api/panels/:name', requireAuth, (req, res) => {
  const d = loadData(BUTTONS_FILE);
  if (!d.panels) d.panels = [];
  const idx = d.panels.findIndex(p => p.name === req.params.name);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  d.panels[idx] = req.body;
  saveData(BUTTONS_FILE, d);
  addLog('UPDATE_PANEL', null, `Panel: ${req.params.name}`);
  res.json({ success: true });
});
app.delete('/api/panels/:name', requireAuth, (req, res) => {
  const d = loadData(BUTTONS_FILE);
  d.panels = (d.panels || []).filter(p => p.name !== req.params.name);
  saveData(BUTTONS_FILE, d);
  addLog('DELETE_PANEL', null, `Panel: ${req.params.name}`);
  res.json({ success: true });
});

// LICENCES
app.get('/api/licenses', requireAuth, (req, res) => { const d = loadData(LICENSES_FILE); res.json(d.licenses || []); });
app.post('/api/licenses', requireAuth, (req, res) => {
  const { userId, username, days } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId requis' });
  const d = loadData(LICENSES_FILE);
  if (!d.licenses) d.licenses = [];
  const key = generateLicenseKey();
  const expiresAt = (days && parseInt(days) > 0) ? new Date(Date.now() + parseInt(days) * 86400000).toISOString() : null;
  d.licenses = d.licenses.map(l => l.userId === userId ? { ...l, active: false } : l);
  d.licenses.unshift({ key, userId, username: username || userId, active: true, createdAt: new Date().toISOString(), expiresAt, createdBy: 'PANEL' });
  saveData(LICENSES_FILE, d);
  addLog('ADD_LICENSE', null, `User: ${username||userId} | Key: ${key}`);
  res.json({ success: true, key });
});
app.patch('/api/licenses/:key', requireAuth, (req, res) => {
  const d = loadData(LICENSES_FILE);
  const lic = d.licenses?.find(l => l.key === req.params.key);
  if (!lic) return res.status(404).json({ error: 'Introuvable' });
  lic.active = req.body.active;
  saveData(LICENSES_FILE, d);
  addLog(req.body.active ? 'ACTIVATE_LICENSE' : 'REVOKE_LICENSE', null, `Key: ${req.params.key}`);
  res.json({ success: true });
});
app.delete('/api/licenses/:key', requireAuth, (req, res) => {
  const d = loadData(LICENSES_FILE);
  d.licenses = (d.licenses || []).filter(l => l.key !== req.params.key);
  saveData(LICENSES_FILE, d);
  addLog('DELETE_LICENSE', null, `Key: ${req.params.key}`);
  res.json({ success: true });
});

// STATS & LOGS
app.get('/api/stats', requireAuth, (req, res) => {
  const stock = loadData(STOCK_FILE);
  const licenses = loadData(LICENSES_FILE);
  const logs = loadData(LOGS_FILE);
  const cats = stock.categories || {};
  const totalItems = Object.values(cats).reduce((a, b) => a + b.length, 0);
  const activeLicenses = (licenses.licenses || []).filter(l => l.active && (l.expiresAt === null || new Date(l.expiresAt) > new Date())).length;
  const genToday = (logs.logs || []).filter(l => l.action === 'GEN' && new Date(l.timestamp).toDateString() === new Date().toDateString()).length;
  res.json({ totalCategories: Object.keys(cats).length, totalItems, activeLicenses, totalLicenses: (licenses.licenses || []).length, genToday });
});
app.get('/api/logs', requireAuth, (req, res) => { const d = loadData(LOGS_FILE); res.json((d.logs || []).slice(0, 100)); });
app.get('/api/config', requireAuth, (req, res) => { const c = loadData(CONFIG_FILE); res.json({ stockChannelId: c.stockChannelId || '' }); });
app.post('/api/config', requireAuth, (req, res) => {
  const c = loadData(CONFIG_FILE);
  if (req.body.stockChannelId !== undefined) c.stockChannelId = req.body.stockChannelId;
  saveData(CONFIG_FILE, c);
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.listen(PORT, () => console.log(`✅ Panneau web démarré sur port ${PORT}`));
