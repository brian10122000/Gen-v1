const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits
} = require('discord.js');
const fs = require('fs');

const CONFIG_FILE   = './data/config.json';
const STOCK_FILE    = './data/stock.json';
const LICENSES_FILE = './data/licenses.json';
const LOGS_FILE     = './data/logs.json';
const BUTTONS_FILE  = './data/buttons.json';
const SERVICES_FILE = './data/services.json';
const LIMITS_FILE   = './data/limits.json';

// ─── Initialisation des fichiers ───────────────────────────────────────────
function initDataFiles() {
  if (!fs.existsSync('./data')) fs.mkdirSync('./data');

  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.CLIENT_ID || '',
    guildId: process.env.GUILD_ID || '',
    panelPort: 3000,
    panelSecret: process.env.PANEL_SECRET || 'changeme',
    stockChannelId: process.env.STOCK_CHANNEL_ID || '',
    adminIds: (process.env.ADMIN_IDS || '').split(',').filter(Boolean),
  }, null, 2));

  if (!fs.existsSync(STOCK_FILE))    fs.writeFileSync(STOCK_FILE,    JSON.stringify({ categories: {} }, null, 2));
  if (!fs.existsSync(LICENSES_FILE)) fs.writeFileSync(LICENSES_FILE, JSON.stringify({ licenses: [] }, null, 2));
  if (!fs.existsSync(LOGS_FILE))     fs.writeFileSync(LOGS_FILE,     JSON.stringify({ logs: [] }, null, 2));
  if (!fs.existsSync(BUTTONS_FILE))  fs.writeFileSync(BUTTONS_FILE,  JSON.stringify({ panels: [] }, null, 2));
  if (!fs.existsSync(SERVICES_FILE)) fs.writeFileSync(SERVICES_FILE, JSON.stringify({ services: [] }, null, 2));
  if (!fs.existsSync(LIMITS_FILE))   fs.writeFileSync(LIMITS_FILE,   JSON.stringify({ cooldowns: {}, dailyGen: {} }, null, 2));
}

function loadData(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function saveData(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

function addLog(action, userId, details) {
  const logs = loadData(LOGS_FILE);
  logs.logs.unshift({ timestamp: new Date().toISOString(), action, userId, details });
  if (logs.logs.length > 500) logs.logs = logs.logs.slice(0, 500);
  saveData(LOGS_FILE, logs);
}

function checkLicense(userId) {
  const cfg = loadData(CONFIG_FILE);
  if (cfg.adminIds && cfg.adminIds.includes(userId)) return { key: 'ADMIN', active: true, expiresAt: null };
  const data = loadData(LICENSES_FILE);
  return data.licenses.find(l =>
    l.userId === userId && l.active &&
    (l.expiresAt === null || new Date(l.expiresAt) > new Date())
  );
}

// ─── Récupère le service lié à une catégorie ───────────────────────────────
function getService(category) {
  const data = loadData(SERVICES_FILE);
  return data.services.find(s => s.category === category) || null;
}

// ─── Vérifie cooldown + limite journalière ─────────────────────────────────
// Retourne null si OK, ou un objet { type: 'cooldown'|'daily', remaining } si bloqué
function checkLimits(userId, category) {
  const service = getService(category);
  if (!service) return null; // Pas de service configuré = pas de limites

  const limits = loadData(LIMITS_FILE);
  const now = Date.now();
  const todayKey = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // ── Cooldown ──
  const cooldownSec = parseInt(service.cooldown) || 0;
  if (cooldownSec > 0) {
    const key = `${userId}_${category}`;
    const lastGen = limits.cooldowns[key] || 0;
    const elapsed = (now - lastGen) / 1000;
    if (elapsed < cooldownSec) {
      return { type: 'cooldown', remaining: Math.ceil(cooldownSec - elapsed) };
    }
  }

  // ── Limite journalière ──
  const maxPerDay = parseInt(service.maxPerDay) || 0;
  if (maxPerDay > 0) {
    const dayKey = `${userId}_${category}_${todayKey}`;
    const count = limits.dailyGen[dayKey] || 0;
    if (count >= maxPerDay) {
      return { type: 'daily', remaining: 0, max: maxPerDay };
    }
  }

  return null;
}

// ─── Enregistre une génération (cooldown + compteur journalier) ────────────
function recordGeneration(userId, category) {
  const limits = loadData(LIMITS_FILE);
  const todayKey = new Date().toISOString().split('T')[0];

  limits.cooldowns[`${userId}_${category}`] = Date.now();

  const dayKey = `${userId}_${category}_${todayKey}`;
  limits.dailyGen[dayKey] = (limits.dailyGen[dayKey] || 0) + 1;

  // Nettoyage des vieilles entrées (> 2 jours)
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];
  for (const k of Object.keys(limits.dailyGen)) {
    const parts = k.split('_');
    const datepart = parts[parts.length - 1];
    if (datepart < twoDaysAgo) delete limits.dailyGen[k];
  }

  saveData(LIMITS_FILE, limits);
}

// ─── Formate le temps restant ──────────────────────────────────────────────
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// ─── Badge service ─────────────────────────────────────────────────────────
function serviceBadge(service) {
  if (!service) return '';
  const type    = service.type    === 'VIP'   ? '👑 VIP'   : '🆓 Gratuit';
  const duree   = service.duree   === 'À vie' ? '♾️ À vie' : '📅 Mensuel';
  const special = service.special ? `✨ ${service.special}` : '';
  return [type, duree, special].filter(Boolean).join(' · ');
}

async function notifyStockAdded(cat, count, addedBy) {
  const config = loadData(CONFIG_FILE);
  if (!config.stockChannelId || !client.isReady()) return;
  try {
    const channel = await client.channels.fetch(config.stockChannelId);
    if (!channel) return;
    const stockData = loadData(STOCK_FILE);
    const total = stockData.categories[cat]?.length || 0;
    await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('📦 Stock mis à jour !')
        .setDescription(`La catégorie **${cat}** a été réapprovisionnée.`)
        .addFields(
          { name: '➕ Ajouté', value: `${count} items`, inline: true },
          { name: '📊 Total',  value: `${total} items`, inline: true },
          { name: '👤 Par',    value: addedBy || 'Panneau Admin', inline: true }
        )
        .setTimestamp()
      ]
    });
  } catch (e) { console.error('Erreur notif:', e.message); }
}

// ─── Construit et envoie un panel de boutons ───────────────────────────────
async function buildAndSendPanel(channel, panelConfig) {
  const stockData   = loadData(STOCK_FILE);
  const servicesData = loadData(SERVICES_FILE);

  const embed = new EmbedBuilder()
    .setColor(parseInt(panelConfig.color?.replace('#', '') || '5865F2', 16))
    .setTitle(panelConfig.title || '⚡ Générateur')
    .setDescription(panelConfig.description || 'Clique sur un bouton pour générer un item.\n> 🔑 Licence requise.');

  if (panelConfig.imageUrl)     { try { embed.setImage(panelConfig.imageUrl); }     catch(e) {} }
  if (panelConfig.thumbnailUrl) { try { embed.setThumbnail(panelConfig.thumbnailUrl); } catch(e) {} }
  if (panelConfig.footerText)   embed.setFooter({ text: panelConfig.footerText });
  embed.setTimestamp();

  const buttons = panelConfig.buttons || [];

  if (panelConfig.showStock) {
    buttons.forEach(btn => {
      const count   = stockData.categories[btn.category]?.length || 0;
      const service = servicesData.services.find(s => s.category === btn.category);
      const badge   = serviceBadge(service);
      embed.addFields({
        name:  `${btn.emoji || '📦'} ${btn.label}`,
        value: `${badge ? badge + '\n' : ''}${count} disponible(s)`,
        inline: true
      });
    });
  }

  const rows = [];

  if (buttons.length === 0) {
    const cats = Object.keys(stockData.categories).filter(c => stockData.categories[c].length > 0);
    let row = new ActionRowBuilder();
    cats.slice(0, 25).forEach((cat, i) => {
      if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`gen_btn_${cat}`)
          .setLabel(`${cat} (${stockData.categories[cat].length})`)
          .setStyle(ButtonStyle.Primary)
      );
    });
    if (cats.length > 0) rows.push(row);
  } else {
    let row = new ActionRowBuilder();
    buttons.slice(0, 25).forEach((btn, i) => {
      if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
      const count = stockData.categories[btn.category]?.length || 0;
      const styleMap = { Primary: ButtonStyle.Primary, Secondary: ButtonStyle.Secondary, Success: ButtonStyle.Success, Danger: ButtonStyle.Danger };
      const builder = new ButtonBuilder()
        .setCustomId(`gen_btn_${btn.category}`)
        .setLabel(btn.showCount ? `${btn.label} (${count})` : btn.label)
        .setStyle(styleMap[btn.style] || ButtonStyle.Primary)
        .setDisabled(btn.disableWhenEmpty && count === 0);
      if (btn.emoji) { try { builder.setEmoji(btn.emoji); } catch(e) {} }
      row.addComponents(builder);
    });
    if (buttons.length > 0) rows.push(row);
  }

  return channel.send({ embeds: [embed], components: rows });
}

// ─── Commandes slash ───────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('gen').setDescription('Génère un item depuis le stock')
    .addStringOption(opt => opt.setName('categorie').setDescription('Catégorie').setRequired(false)),

  new SlashCommandBuilder().setName('genpanel').setDescription('[ADMIN] Envoie un panneau de génération avec boutons')
    .addStringOption(opt => opt.setName('panel').setDescription('Nom du panel configuré (laisser vide = défaut)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('panel').setDescription('[ADMIN] Lien du panneau web')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('setchannel').setDescription('[ADMIN] Channel de notification stock')
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('addstock').setDescription('[ADMIN] Ajoute du stock')
    .addStringOption(opt => opt.setName('categorie').setDescription('Catégorie').setRequired(true))
    .addStringOption(opt => opt.setName('items').setDescription('Items séparés par des virgules').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('addlicense').setDescription('[ADMIN] Crée une licence')
    .addUserOption(opt => opt.setName('utilisateur').setDescription('Utilisateur').setRequired(true))
    .addIntegerOption(opt => opt.setName('duree').setDescription('Durée en jours (0 = permanente)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('revokelicense').setDescription('[ADMIN] Révoque une licence')
    .addUserOption(opt => opt.setName('utilisateur').setDescription('Utilisateur').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('mylicense').setDescription('Vérifie ta licence'),

  new SlashCommandBuilder().setName('stock').setDescription('[ADMIN] Voir le stock')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ─── Init ──────────────────────────────────────────────────────────────────
initDataFiles();
const config = loadData(CONFIG_FILE);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Commandes enregistrées.');
  } catch (err) { console.error('❌ Erreur commandes :', err.message); }
});

// ─── Handler interactions ──────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ======= BOUTONS =======
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith('gen_btn_')) return;
    const cat     = interaction.customId.replace('gen_btn_', '');
    const userId  = interaction.user.id;
    const service = getService(cat);

    // Vérif licence
    const license = checkLicense(userId);
    if (!license) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFF4444).setTitle('❌ Accès refusé')
          .setDescription('Tu n\'as pas de licence active.\nContacte un administrateur.')],
        ephemeral: true
      });
    }

    // Vérif type VIP
    if (service?.type === 'VIP' && license.key !== 'ADMIN' && !license.isVip) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFFD700).setTitle('👑 Accès VIP requis')
          .setDescription(`Ce service nécessite une licence **VIP**.\nContacte un administrateur.`)],
        ephemeral: true
      });
    }

    // Vérif cooldown / limite journalière
    const limitCheck = checkLimits(userId, cat);
    if (limitCheck) {
      if (limitCheck.type === 'cooldown') {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xFF8800).setTitle('⏳ Cooldown actif')
            .setDescription(`Tu dois attendre encore **${formatDuration(limitCheck.remaining)}** avant de générer à nouveau dans **${cat}**.`)],
          ephemeral: true
        });
      }
      if (limitCheck.type === 'daily') {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xFF8800).setTitle('📅 Limite journalière atteinte')
            .setDescription(`Tu as atteint la limite de **${limitCheck.max} génération(s)/jour** pour **${cat}**.\nReviens demain !`)],
          ephemeral: true
        });
      }
    }

    // Vérif stock
    const stockData = loadData(STOCK_FILE);
    const items = stockData.categories[cat];
    if (!items || items.length === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFF8800).setTitle('📦 Stock épuisé').setDescription(`**${cat}** est vide.`)],
        ephemeral: true
      });
    }

    // Génération
    const item = items.shift();
    stockData.categories[cat] = items;
    saveData(STOCK_FILE, stockData);
    recordGeneration(userId, cat);
    addLog('GEN', userId, `Cat: ${cat} | Item: ${item}`);

    // Mettre à jour les boutons du message
    try {
      const updatedStock = loadData(STOCK_FILE);
      const newComponents = interaction.message.components.map(row => {
        const newRow = new ActionRowBuilder();
        row.components.forEach(btn => {
          const btnCat  = btn.customId?.replace('gen_btn_', '');
          const count   = updatedStock.categories[btnCat]?.length || 0;
          const oldLabel = btn.label || '';
          const newLabel = oldLabel.replace(/\(\d+\)/, `(${count})`);
          const builder  = new ButtonBuilder()
            .setCustomId(btn.customId)
            .setLabel(newLabel)
            .setStyle(btn.style)
            .setDisabled(count === 0 && btn.disabled);
          if (btn.emoji) try { builder.setEmoji(btn.emoji.name || btn.emoji.id); } catch(e) {}
          newRow.addComponents(builder);
        });
        return newRow;
      });
      await interaction.message.edit({ components: newComponents });
    } catch(e) {}

    // Construire l'embed de résultat
    const badge = serviceBadge(service);
    const limitsInfo = [];
    if (service?.cooldown > 0)    limitsInfo.push(`⏱️ Cooldown : ${formatDuration(parseInt(service.cooldown))}`);
    if (service?.maxPerDay > 0)   limitsInfo.push(`📅 Limite : ${service.maxPerDay}/jour`);

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('✅ Génération réussie !')
      .setDescription(`**Catégorie :** \`${cat}\`\n${badge ? `**Service :** ${badge}\n` : ''}\n\`\`\`\n${item}\n\`\`\``)
      .setFooter({ text: `Stock restant : ${items.length}${limitsInfo.length ? ' · ' + limitsInfo.join(' · ') : ''} | ${interaction.user.tag}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // ======= /gen =======
  if (commandName === 'gen') {
    const license = checkLicense(interaction.user.id);
    if (!license) return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFF4444).setTitle('❌ Accès refusé').setDescription('Licence requise. Contacte un admin.')],
      ephemeral: true
    });

    const stockData  = loadData(STOCK_FILE);
    const categories = Object.keys(stockData.categories).filter(c => stockData.categories[c].length > 0);
    if (categories.length === 0) return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFF8800).setTitle('📦 Stock vide')],
      ephemeral: true
    });

    const requestedCat = interaction.options.getString('categorie');
    let selectedCat = requestedCat ? categories.find(c => c.toLowerCase() === requestedCat.toLowerCase()) : null;

    if (!selectedCat && requestedCat) return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFF4444).setTitle('❌ Catégorie introuvable')
        .setDescription(`Disponibles : ${categories.map(c => `\`${c}\``).join(', ')}`)],
      ephemeral: true
    });

    if (!selectedCat) {
      const rows = [];
      let row = new ActionRowBuilder();
      categories.slice(0, 25).forEach((cat, i) => {
        if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`gen_btn_${cat}`)
            .setLabel(`🎁 ${cat} (${stockData.categories[cat].length})`)
            .setStyle(ButtonStyle.Primary)
        );
      });
      rows.push(row);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🎁 Générateur').setDescription('Choisis une catégorie :')],
        components: rows, ephemeral: true
      });
    }

    // Vérif limites pour /gen aussi
    const limitCheck = checkLimits(interaction.user.id, selectedCat);
    if (limitCheck) {
      if (limitCheck.type === 'cooldown') {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xFF8800).setTitle('⏳ Cooldown actif')
            .setDescription(`Attends encore **${formatDuration(limitCheck.remaining)}**.`)],
          ephemeral: true
        });
      }
      if (limitCheck.type === 'daily') {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xFF8800).setTitle('📅 Limite journalière atteinte')
            .setDescription(`Limite de **${limitCheck.max}/jour** atteinte pour **${selectedCat}**. Reviens demain !`)],
          ephemeral: true
        });
      }
    }

    const items = stockData.categories[selectedCat];
    const item  = items.shift();
    stockData.categories[selectedCat] = items;
    saveData(STOCK_FILE, stockData);
    recordGeneration(interaction.user.id, selectedCat);
    addLog('GEN', interaction.user.id, `Cat: ${selectedCat} | Item: ${item}`);

    const service = getService(selectedCat);
    const badge   = serviceBadge(service);

    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Génération réussie !')
        .setDescription(`**Catégorie :** \`${selectedCat}\`\n${badge ? `**Service :** ${badge}\n` : ''}\n\`\`\`\n${item}\n\`\`\``)
        .setFooter({ text: `Stock restant : ${items.length} | ${interaction.user.tag}` }).setTimestamp()],
      ephemeral: true
    });
  }

  // ======= /genpanel =======
  if (commandName === 'genpanel') {
    await interaction.deferReply({ ephemeral: true });
    const panelName   = interaction.options.getString('panel') || 'default';
    const buttonsData = loadData(BUTTONS_FILE);
    const panelConfig = buttonsData.panels.find(p => p.name === panelName) || {
      title: '⚡ Générateur', description: 'Clique sur un bouton pour générer.\n> 🔑 Licence requise.', buttons: [], color: '#5865F2'
    };
    await buildAndSendPanel(interaction.channel, panelConfig);
    return interaction.editReply({ content: '✅ Panel envoyé !' });
  }

  // ======= /panel =======
  if (commandName === 'panel') {
    const cfg = loadData(CONFIG_FILE);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🖥️ Panneau Admin')
        .setDescription(`**Mot de passe :** \`${cfg.panelSecret}\``)],
      ephemeral: true
    });
  }

  // ======= /setchannel =======
  if (commandName === 'setchannel') {
    const channel = interaction.options.getChannel('channel');
    const cfg = loadData(CONFIG_FILE);
    cfg.stockChannelId = channel.id;
    saveData(CONFIG_FILE, cfg);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Channel configuré')
        .setDescription(`Notifications → ${channel}`)],
      ephemeral: true
    });
  }

  // ======= /addstock =======
  if (commandName === 'addstock') {
    const cat      = interaction.options.getString('categorie');
    const itemsRaw = interaction.options.getString('items');
    const items    = itemsRaw.split(',').map(i => i.trim()).filter(Boolean);
    const stockData = loadData(STOCK_FILE);
    if (!stockData.categories[cat]) stockData.categories[cat] = [];
    stockData.categories[cat].push(...items);
    saveData(STOCK_FILE, stockData);
    addLog('ADD_STOCK', interaction.user.id, `Cat: ${cat} | +${items.length}`);
    await notifyStockAdded(cat, items.length, interaction.user.tag);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock ajouté')
        .setDescription(`**${items.length}** items dans \`${cat}\`. Total: **${stockData.categories[cat].length}**`)],
      ephemeral: true
    });
  }

  // ======= /addlicense =======
  if (commandName === 'addlicense') {
    const target = interaction.options.getUser('utilisateur');
    const days   = interaction.options.getInteger('duree') || 0;
    const data   = loadData(LICENSES_FILE);
    const key    = generateLicenseKey();
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
    data.licenses = data.licenses.map(l => l.userId === target.id ? { ...l, active: false } : l);
    data.licenses.unshift({ key, userId: target.id, username: target.tag, active: true, createdAt: new Date().toISOString(), expiresAt, createdBy: interaction.user.id });
    saveData(LICENSES_FILE, data);
    addLog('ADD_LICENSE', interaction.user.id, `User: ${target.tag} | Key: ${key}`);
    try {
      await target.send({
        embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('🔑 Licence activée !')
          .setDescription(`**Clé :** \`${key}\`\n**Expiration :** ${expiresAt ? new Date(expiresAt).toLocaleDateString('fr-FR') : 'Permanente'}\n\nUtilise \`/gen\` pour accéder au générateur.`)
          .setTimestamp()]
      });
    } catch(e) {}
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Licence créée')
        .addFields(
          { name: '👤 Utilisateur', value: target.tag, inline: true },
          { name: '🔑 Clé', value: `\`${key}\``, inline: true },
          { name: '📅 Expiration', value: expiresAt ? new Date(expiresAt).toLocaleDateString('fr-FR') : 'Permanente', inline: true }
        )],
      ephemeral: true
    });
  }

  // ======= /revokelicense =======
  if (commandName === 'revokelicense') {
    const target = interaction.options.getUser('utilisateur');
    const data   = loadData(LICENSES_FILE);
    data.licenses = data.licenses.map(l => l.userId === target.id ? { ...l, active: false } : l);
    saveData(LICENSES_FILE, data);
    addLog('REVOKE_LICENSE', interaction.user.id, `User: ${target.tag}`);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFF4444).setTitle('🔒 Licence révoquée').setDescription(`**${target.tag}** révoqué.`)],
      ephemeral: true
    });
  }

  // ======= /mylicense =======
  if (commandName === 'mylicense') {
    const license = checkLicense(interaction.user.id);
    if (!license) return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFF4444).setTitle('❌ Aucune licence').setDescription('Contacte un administrateur.')],
      ephemeral: true
    });
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Licence active')
        .addFields(
          { name: '🔑 Clé', value: `\`${license.key}\``, inline: true },
          { name: '📅 Expiration', value: license.expiresAt ? new Date(license.expiresAt).toLocaleDateString('fr-FR') : 'Permanente', inline: true }
        )],
      ephemeral: true
    });
  }

  // ======= /stock =======
  if (commandName === 'stock') {
    const stockData    = loadData(STOCK_FILE);
    const servicesData = loadData(SERVICES_FILE);
    const cats         = Object.keys(stockData.categories);
    if (!cats.length) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF8800).setTitle('📦 Stock vide')], ephemeral: true });

    const fields = cats.map(c => {
      const service = servicesData.services.find(s => s.category === c);
      const badge   = serviceBadge(service);
      return {
        name:  `${c}`,
        value: `📦 ${stockData.categories[c].length} item(s)${badge ? '\n' + badge : ''}`,
        inline: true
      };
    });

    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📦 Stock').addFields(...fields)],
      ephemeral: true
    });
  }
});

module.exports = { client, notifyStockAdded, loadData, saveData, STOCK_FILE, LICENSES_FILE, LOGS_FILE, CONFIG_FILE, BUTTONS_FILE, SERVICES_FILE, LIMITS_FILE, generateLicenseKey, addLog };
client.login(config.token);
