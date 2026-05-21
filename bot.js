const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ==================== CONFIG ====================
const CONFIG_FILE = './data/config.json';
const STOCK_FILE = './data/stock.json';
const LICENSES_FILE = './data/licenses.json';
const LOGS_FILE = './data/logs.json';

// Initialisation des fichiers de données
function initDataFiles() {
  if (!fs.existsSync('./data')) fs.mkdirSync('./data');

  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      token: process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN',
      clientId: process.env.CLIENT_ID || 'YOUR_CLIENT_ID',
      guildId: process.env.GUILD_ID || 'YOUR_GUILD_ID',
      adminRoleId: process.env.ADMIN_ROLE_ID || '',
      panelPort: 3000,
      panelSecret: process.env.PANEL_SECRET || 'changeme_secret_panel',
    }, null, 2));
  }

  if (!fs.existsSync(STOCK_FILE)) {
    fs.writeFileSync(STOCK_FILE, JSON.stringify({ categories: {} }, null, 2));
  }

  if (!fs.existsSync(LICENSES_FILE)) {
    fs.writeFileSync(LICENSES_FILE, JSON.stringify({ licenses: [] }, null, 2));
  }

  if (!fs.existsSync(LOGS_FILE)) {
    fs.writeFileSync(LOGS_FILE, JSON.stringify({ logs: [] }, null, 2));
  }
}

// ==================== HELPERS ====================
function loadData(file) {
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
  logs.logs.unshift({
    timestamp: new Date().toISOString(),
    action,
    userId,
    details,
  });
  if (logs.logs.length > 500) logs.logs = logs.logs.slice(0, 500);
  saveData(LOGS_FILE, logs);
}

function checkLicense(userId) {
  const data = loadData(LICENSES_FILE);
  return data.licenses.find(l =>
    l.userId === userId &&
    l.active &&
    (l.expiresAt === null || new Date(l.expiresAt) > new Date())
  );
}

// ==================== COMMANDES SLASH ====================
const commands = [
  new SlashCommandBuilder()
    .setName('gen')
    .setDescription('Génère un item depuis le stock')
    .addStringOption(opt =>
      opt.setName('categorie')
        .setDescription('La catégorie à générer')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Affiche le lien du panneau de gestion'),

  new SlashCommandBuilder()
    .setName('addstock')
    .setDescription('[ADMIN] Ajoute du stock manuellement')
    .addStringOption(opt =>
      opt.setName('categorie').setDescription('Nom de la catégorie').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('items').setDescription('Items séparés par des virgules').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('addlicense')
    .setDescription('[ADMIN] Crée une licence pour un utilisateur')
    .addUserOption(opt =>
      opt.setName('utilisateur').setDescription('L\'utilisateur').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('duree').setDescription('Durée en jours (0 = permanente)').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('revokelicense')
    .setDescription('[ADMIN] Révoque la licence d\'un utilisateur')
    .addUserOption(opt =>
      opt.setName('utilisateur').setDescription('L\'utilisateur').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('mylicense')
    .setDescription('Vérifie le statut de ta licence'),

  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('[ADMIN] Affiche le stock actuel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ==================== BOT ====================
initDataFiles();
const config = loadData(CONFIG_FILE);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);

  // Enregistrement des commandes
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('✅ Commandes slash enregistrées.');
  } catch (err) {
    console.error('❌ Erreur enregistrement commandes :', err);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ======= /gen =======
  if (commandName === 'gen') {
    const license = checkLicense(interaction.user.id);
    if (!license) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xFF4444)
          .setTitle('❌ Accès refusé')
          .setDescription('Tu n\'as pas de licence active pour utiliser ce générateur.\n\nContacte un administrateur pour en obtenir une.')
          .setFooter({ text: 'Générateur • Système de licences' })
        ],
        ephemeral: true
      });
    }

    const stockData = loadData(STOCK_FILE);
    const categories = Object.keys(stockData.categories);

    if (categories.length === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xFF8800)
          .setTitle('📦 Stock vide')
          .setDescription('Aucune catégorie disponible pour le moment.')
        ],
        ephemeral: true
      });
    }

    const requestedCat = interaction.options.getString('categorie');
    let selectedCat;

    if (requestedCat) {
      const found = categories.find(c => c.toLowerCase() === requestedCat.toLowerCase());
      if (!found) {
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xFF4444)
            .setTitle('❌ Catégorie introuvable')
            .setDescription(`La catégorie **${requestedCat}** n'existe pas.\n\nCatégories disponibles : ${categories.map(c => `\`${c}\``).join(', ')}`)
          ],
          ephemeral: true
        });
      }
      selectedCat = found;
    } else {
      // Affiche les catégories avec boutons
      if (categories.length === 1) {
        selectedCat = categories[0];
      } else {
        const rows = [];
        let row = new ActionRowBuilder();
        for (let i = 0; i < Math.min(categories.length, 25); i++) {
          if (i > 0 && i % 5 === 0) {
            rows.push(row);
            row = new ActionRowBuilder();
          }
          const cat = categories[i];
          const count = stockData.categories[cat]?.length || 0;
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`gen_cat_${cat}`)
              .setLabel(`${cat} (${count})`)
              .setStyle(ButtonStyle.Primary)
              .setDisabled(count === 0)
          );
        }
        rows.push(row);

        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎁 Générateur')
            .setDescription('Choisis une catégorie :')
          ],
          components: rows,
          ephemeral: true
        });
      }
    }

    // Générer depuis la catégorie
    const items = stockData.categories[selectedCat];
    if (!items || items.length === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xFF8800)
          .setTitle('📦 Stock épuisé')
          .setDescription(`La catégorie **${selectedCat}** est vide.`)
        ],
        ephemeral: true
      });
    }

    const item = items.shift();
    stockData.categories[selectedCat] = items;
    saveData(STOCK_FILE, stockData);

    addLog('GEN', interaction.user.id, `Catégorie: ${selectedCat} | Item: ${item}`);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Génération réussie')
        .setDescription(`**Catégorie :** \`${selectedCat}\`\n\n\`\`\`\n${item}\n\`\`\``)
        .setFooter({ text: `Stock restant : ${items.length} | ${interaction.user.tag}` })
        .setTimestamp()
      ],
      ephemeral: true
    });
  }

  // ======= Bouton catégorie (gen_cat_xxx) =======
  // (géré dans le handler button ci-dessous)

  // ======= /panel =======
  if (commandName === 'panel') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Réservé aux admins.', ephemeral: true });
    }
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🖥️ Panneau de gestion')
        .setDescription(`**URL :** http://localhost:${config.panelPort}\n**Mot de passe :** \`${config.panelSecret}\`\n\nGère le stock, les licences et les logs depuis l\'interface web.`)
        .setFooter({ text: 'Panneau Admin' })
      ],
      ephemeral: true
    });
  }

  // ======= /addstock =======
  if (commandName === 'addstock') {
    const cat = interaction.options.getString('categorie');
    const itemsRaw = interaction.options.getString('items');
    const items = itemsRaw.split(',').map(i => i.trim()).filter(Boolean);

    const stockData = loadData(STOCK_FILE);
    if (!stockData.categories[cat]) stockData.categories[cat] = [];
    stockData.categories[cat].push(...items);
    saveData(STOCK_FILE, stockData);

    addLog('ADD_STOCK', interaction.user.id, `Cat: ${cat} | +${items.length} items`);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Stock ajouté')
        .setDescription(`**${items.length}** item(s) ajouté(s) dans \`${cat}\`.\nStock total : **${stockData.categories[cat].length}**`)
      ],
      ephemeral: true
    });
  }

  // ======= /addlicense =======
  if (commandName === 'addlicense') {
    const target = interaction.options.getUser('utilisateur');
    const days = interaction.options.getInteger('duree') || 0;

    const data = loadData(LICENSES_FILE);
    const key = generateLicenseKey();
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;

    // Désactiver les anciennes licences
    data.licenses = data.licenses.map(l =>
      l.userId === target.id ? { ...l, active: false } : l
    );

    data.licenses.unshift({
      key,
      userId: target.id,
      username: target.tag,
      active: true,
      createdAt: new Date().toISOString(),
      expiresAt,
      createdBy: interaction.user.id,
    });

    saveData(LICENSES_FILE, data);
    addLog('ADD_LICENSE', interaction.user.id, `User: ${target.tag} | Key: ${key} | Durée: ${days === 0 ? 'Permanente' : days + 'j'}`);

    try {
      await target.send({
        embeds: [new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('🔑 Licence activée !')
          .setDescription(`Ta licence a été activée par un administrateur.\n\n**Clé :** \`${key}\`\n**Expiration :** ${expiresAt ? new Date(expiresAt).toLocaleDateString('fr-FR') : 'Permanente'}\n\nTu peux maintenant utiliser \`/gen\` pour accéder au générateur.`)
          .setTimestamp()
        ]
      });
    } catch (e) { /* DMs fermés */ }

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Licence créée')
        .setDescription(`**Utilisateur :** ${target.tag}\n**Clé :** \`${key}\`\n**Expiration :** ${expiresAt ? new Date(expiresAt).toLocaleDateString('fr-FR') : 'Permanente'}`)
      ],
      ephemeral: true
    });
  }

  // ======= /revokelicense =======
  if (commandName === 'revokelicense') {
    const target = interaction.options.getUser('utilisateur');
    const data = loadData(LICENSES_FILE);

    data.licenses = data.licenses.map(l =>
      l.userId === target.id ? { ...l, active: false } : l
    );
    saveData(LICENSES_FILE, data);
    addLog('REVOKE_LICENSE', interaction.user.id, `User: ${target.tag}`);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xFF4444)
        .setTitle('🔒 Licence révoquée')
        .setDescription(`La licence de **${target.tag}** a été révoquée.`)
      ],
      ephemeral: true
    });
  }

  // ======= /mylicense =======
  if (commandName === 'mylicense') {
    const license = checkLicense(interaction.user.id);
    if (!license) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xFF4444)
          .setTitle('❌ Aucune licence active')
          .setDescription('Tu n\'as pas de licence active.\nContacte un administrateur.')
        ],
        ephemeral: true
      });
    }

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Licence active')
        .addFields(
          { name: '🔑 Clé', value: `\`${license.key}\``, inline: true },
          { name: '📅 Expiration', value: license.expiresAt ? new Date(license.expiresAt).toLocaleDateString('fr-FR') : 'Permanente', inline: true },
          { name: '📆 Créée le', value: new Date(license.createdAt).toLocaleDateString('fr-FR'), inline: true }
        )
      ],
      ephemeral: true
    });
  }

  // ======= /stock =======
  if (commandName === 'stock') {
    const stockData = loadData(STOCK_FILE);
    const cats = Object.keys(stockData.categories);

    if (cats.length === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFF8800).setTitle('📦 Stock vide').setDescription('Aucun stock.')],
        ephemeral: true
      });
    }

    const lines = cats.map(c => `**${c}** : ${stockData.categories[c].length} item(s)`).join('\n');

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📦 Stock actuel')
        .setDescription(lines)
      ],
      ephemeral: true
    });
  }
});

// Gestion des boutons (sélection catégorie)
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('gen_cat_')) return;

  const cat = interaction.customId.replace('gen_cat_', '');
  const license = checkLicense(interaction.user.id);

  if (!license) {
    return interaction.reply({ content: '❌ Licence requise.', ephemeral: true });
  }

  const stockData = loadData(STOCK_FILE);
  const items = stockData.categories[cat];

  if (!items || items.length === 0) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xFF8800).setTitle('📦 Stock épuisé').setDescription(`La catégorie **${cat}** est vide.`)],
      ephemeral: true
    });
  }

  const item = items.shift();
  stockData.categories[cat] = items;
  saveData(STOCK_FILE, stockData);

  addLog('GEN', interaction.user.id, `Catégorie: ${cat} | Item: ${item}`);

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('✅ Génération réussie')
      .setDescription(`**Catégorie :** \`${cat}\`\n\n\`\`\`\n${item}\n\`\`\``)
      .setFooter({ text: `Stock restant : ${items.length} | ${interaction.user.tag}` })
      .setTimestamp()
    ],
    ephemeral: true
  });
});

client.login(config.token);

module.exports = { loadData, saveData, STOCK_FILE, LICENSES_FILE, LOGS_FILE, generateLicenseKey, addLog };
