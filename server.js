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

// ==================== HELPERS ====================
function loadData(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
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

// ==================== MIDDLEWARE ====================
const config = loadData(CONFIG_FILE);
const PORT = config.panelPort || 3000;
const SECRET = config.panelSecret || 'changeme_secret_panel';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SECRET + '_session',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.status(401).json({ error: 'Non authentifié' });
}

// ==================== ROUTES AUTH ====================
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const cfg = loadData(CONFIG_FILE);
  if (password === cfg.panelSecret) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Mot de passe incorrect' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!req.session?.authenticated });
});

// ==================== ROUTES STOCK ====================
app.get('/api/stock', requireAuth, (req, res) => {
  const data = loadData(STOCK_FILE);
  res.json(data.categories || {});
});

app.post('/api/stock/category', requireAuth, (req, res) => {
  const { name, displayName } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });

  const data = loadData(STOCK_FILE);
  if (!data.categories) data.categories = {};
  if (data.categories[name]) return res.status(400).json({ error: 'Catégorie déjà existante' });

  data.categories[name] = [];
  if (!data.meta) data.meta = {};
  data.meta[name] = { displayName: displayName || name, createdAt: new Date().toISOString() };
  saveData(STOCK_FILE, data);
  addLog('CREATE_CATEGORY', null, `Cat: ${name}`);
  res.json({ success: true });
});

app.delete('/api/stock/category/:name', requireAuth, (req, res) => {
  const { name } = req.params;
  const data = loadData(STOCK_FILE);
  if (!data.categories?.[name]) return res.status(404).json({ error: 'Catégorie introuvable' });

  delete data.categories[name];
  if (data.meta) delete data.meta[name];
  saveData(STOCK_FILE, data);
  addLog('DELETE_CATEGORY', null, `Cat: ${name}`);
  res.json({ success: true });
});

app.post('/api/stock/:category/items', requireAuth, (req, res) => {
  const { category } = req.params;
  const { items } = req.body;
  if (!items) return res.status(400).json({ error: 'Items requis' });

  const data = loadData(STOCK_FILE);
  if (!data.categories) data.categories = {};
  if (!data.categories[category]) data.categories[category] = [];

  const parsed = items.split('\n').map(i => i.trim()).filter(Boolean);
  data.categories[category].push(...parsed);
  saveData(STOCK_FILE, data);
  addLog('ADD_STOCK', null, `Cat: ${category} | +${parsed.length} items`);
  res.json({ success: true, added: parsed.length, total: data.categories[category].length });
});

app.delete('/api/stock/:category/items', requireAuth, (req, res) => {
  const { category } = req.params;
  const data = loadData(STOCK_FILE);
  if (!data.categories?.[category]) return res.status(404).json({ error: 'Catégorie introuvable' });
  data.categories[category] = [];
  saveData(STOCK_FILE, data);
  addLog('CLEAR_STOCK', null, `Cat: ${category}`);
  res.json({ success: true });
});

app.delete('/api/stock/:category/item/:index', requireAuth, (req, res) => {
  const { category, index } = req.params;
  const data = loadData(STOCK_FILE);
  if (!data.categories?.[category]) return res.status(404).json({ error: 'Catégorie introuvable' });
  data.categories[category].splice(parseInt(index), 1);
  saveData(STOCK_FILE, data);
  res.json({ success: true });
});

// ==================== ROUTES LICENCES ====================
app.get('/api/licenses', requireAuth, (req, res) => {
  const data = loadData(LICENSES_FILE);
  res.json(data.licenses || []);
});

app.post('/api/licenses', requireAuth, (req, res) => {
  const { userId, username, days } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId requis' });

  const data = loadData(LICENSES_FILE);
  if (!data.licenses) data.licenses = [];

  const key = generateLicenseKey();
  const expiresAt = (days && days > 0) ? new Date(Date.now() + days * 86400000).toISOString() : null;

  // Désactiver les anciennes licences
  data.licenses = data.licenses.map(l =>
    l.userId === userId ? { ...l, active: false } : l
  );

  data.licenses.unshift({
    key,
    userId,
    username: username || userId,
    active: true,
    createdAt: new Date().toISOString(),
    expiresAt,
    createdBy: 'PANEL',
  });

  saveData(LICENSES_FILE, data);
  addLog('ADD_LICENSE', null, `User: ${username || userId} | Key: ${key}`);
  res.json({ success: true, key });
});

app.patch('/api/licenses/:key', requireAuth, (req, res) => {
  const { key } = req.params;
  const { active } = req.body;

  const data = loadData(LICENSES_FILE);
  const license = data.licenses?.find(l => l.key === key);
  if (!license) return res.status(404).json({ error: 'Licence introuvable' });

  license.active = active;
  saveData(LICENSES_FILE, data);
  addLog(active ? 'ACTIVATE_LICENSE' : 'REVOKE_LICENSE', null, `Key: ${key}`);
  res.json({ success: true });
});

app.delete('/api/licenses/:key', requireAuth, (req, res) => {
  const { key } = req.params;
  const data = loadData(LICENSES_FILE);
  data.licenses = data.licenses?.filter(l => l.key !== key) || [];
  saveData(LICENSES_FILE, data);
  addLog('DELETE_LICENSE', null, `Key: ${key}`);
  res.json({ success: true });
});

// ==================== ROUTES STATS ====================
app.get('/api/stats', requireAuth, (req, res) => {
  const stock = loadData(STOCK_FILE);
  const licenses = loadData(LICENSES_FILE);
  const logs = loadData(LOGS_FILE);

  const cats = stock.categories || {};
  const totalItems = Object.values(cats).reduce((a, b) => a + b.length, 0);
  const activeLicenses = (licenses.licenses || []).filter(l =>
    l.active && (l.expiresAt === null || new Date(l.expiresAt) > new Date())
  ).length;

  const genToday = (logs.logs || []).filter(l =>
    l.action === 'GEN' && new Date(l.timestamp).toDateString() === new Date().toDateString()
  ).length;

  res.json({
    totalCategories: Object.keys(cats).length,
    totalItems,
    activeLicenses,
    totalLicenses: (licenses.licenses || []).length,
    genToday,
    totalLogs: (logs.logs || []).length,
  });
});

app.get('/api/logs', requireAuth, (req, res) => {
  const data = loadData(LOGS_FILE);
  res.json((data.logs || []).slice(0, 100));
});

// ==================== PAGE PRINCIPALE ====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Panneau web démarré sur http://localhost:${PORT}`);
});
