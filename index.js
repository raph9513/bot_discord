// ——— Chargement des dépendances ———
require("dotenv").config();
const express = require("express");
const playdl = require("play-dl");
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
} = require("@discordjs/voice");

//////////////////////
// Fonctions de log //
//////////////////////
const NIVEAUX = {
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
  PLAY: "PLAY",
  YT_PLAYLIST: "YT-PLAYLIST",
};
function log(niveau, message) {
  const now = new Date().toISOString();
  console.log(`[${niveau}] ${now} ${message}`);
}

//////////////////////
// Configuration    //
//////////////////////
const {
  DISCORD_TOKEN,
  PREFIX = "!",
  COOKIE_PATH = "./cookies.json",
  PORT = 8080,
} = process.env;

if (!DISCORD_TOKEN) {
  log(NIVEAUX.ERROR, "❌ DISCORD_TOKEN non défini. Arrêt du bot.");
  process.exit(1);
}

//////////////////////
// Chargement cookies//
//////////////////////
let cookieHeader = "";
try {
  const cookies = JSON.parse(fs.readFileSync(path.resolve(COOKIE_PATH), "utf8"));
  // cookies.json doit être un tableau d’objets { name, value }
  cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
  log(NIVEAUX.INFO, `✅ Cookies chargés depuis ${COOKIE_PATH}`);
} catch (err) {
  log(NIVEAUX.WARN, `⚠️ Impossible de charger les cookies : ${err.message}`);
}

//////////////////////
// Serveur HTTP     //
//////////////////////
const app = express();
app.get("/", (_req, res) => res.send("🤖 Bot actif"));
const server = app.listen(PORT, () => {
  log(NIVEAUX.INFO, `Serveur HTTP démarré sur le port ${PORT}`);
});
server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    log(NIVEAUX.WARN, `Port ${PORT} déjà utilisé, HTTP skip.`);
  } else {
    throw err;
  }
});

//////////////////////
// Client Discord   //
//////////////////////
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Map guildId → { player, tracks[], voiceChannel, textChannel, volume, resource }
const queues = new Map();

client.once("ready", () => {
  log(NIVEAUX.INFO, `✅ Connecté comme ${client.user.tag}`);
});

client.on("messageCreate", async message => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const [commande, ...args] = message.content
    .slice(PREFIX.length)
    .trim()
    .split(/\s+/);
  const guildId = message.guild.id;

  // Initialisation de la file si nécessaire
  if (!queues.has(guildId)) {
    const player = createAudioPlayer();
    queues.set(guildId, {
      player,
      tracks: [],
      voiceChannel: null,
      textChannel: null,
      volume: 1.0,
      resource: null,
    });
    player.on(AudioPlayerStatus.Idle, () => {
      const q = queues.get(guildId);
      q.tracks.shift();
      if (q.tracks.length) return playNext(guildId);
      getVoiceConnection(guildId)?.destroy();
      queues.delete(guildId);
    });
  }
  const q = queues.get(guildId);

  try {
    switch (commande.toLowerCase()) {
      case "play":
        return handlePlay(message, args[0] || "");

      case "pause":
        q.player.pause();
        return message.reply("⏸️ Lecture en pause.");

      case "resume":
        q.player.unpause();
        return message.reply("▶️ Lecture reprise.");

      case "skip":
        q.player.stop();
        return message.reply("⏭️ Piste suivante.");

      case "stop":
        q.tracks = [];
        q.player.stop();
        getVoiceConnection(guildId)?.destroy();
        queues.delete(guildId);
        return message.reply("⏹️ Lecture arrêtée et file vidée.");

      case "queue":
        if (!q.tracks.length) return message.reply("📭 File vide.");
        return message.channel.send(
          "🎶 File :\n" +
            q.tracks.map((u, i) => `${i+1}. ${u}`).join("\n")
        );

      case "volume": {
        const v = parseInt(args[0], 10);
        if (isNaN(v) || v<0 || v>100) {
          return message.reply("❌ Utilisation : volume 0–100");
        }
        q.volume = v/100;
        if (q.resource?.volume) q.resource.volume.setVolume(q.volume);
        return message.reply(`🔊 Volume à ${v}%`);
      }

      case "all":
        return message.reply(`
📜 Commandes :
${PREFIX}play <URL>       — Jouer vidéo/playlist  
${PREFIX}pause            — Pause  
${PREFIX}resume           — Reprendre  
${PREFIX}skip             — Passer  
${PREFIX}stop             — Stop + vider  
${PREFIX}queue            — Afficher file  
${PREFIX}volume <0‑100>   — Volume  
${PREFIX}all              — Aide
        `);

      default:
        return message.reply("❓ Commande inconnue. Tapez `all` pour l’aide.");
    }
  } catch (err) {
    log(NIVEAUX.ERROR, `Erreur handler : ${err.stack||err.message}`);
    message.reply("❌ Erreur inattendue.");
  }
});

//////////////////////
// Fonction handlePlay
//////////////////////
async function handlePlay(message, url) {
  const guildId = message.guild.id;
  const q = queues.get(guildId);

  if (!url.startsWith("http")) {
    return message.reply("❌ URL invalide.");
  }

  q.voiceChannel = message.member.voice.channel;
  q.textChannel = message.channel;

  // Playlist ?
  if (url.includes("list=")) {
    log(NIVEAUX.YT_PLAYLIST, `Expansion de ${url}`);
    try {
      const pl = await playdl.playlist_info(url, { incomplete: true });
      const vids = pl.videos.slice(0, 20);
      vids.forEach(v => q.tracks.push(v.url));
      message.reply(`➕ ${vids.length} vidéos ajoutées.`);
    } catch (err) {
      log(NIVEAUX.YT_PLAYLIST, `Erreur playlist_info : ${err.message}`);
      // fallback = lire la première vidéo
      const seule = url.split("&")[0];
      q.tracks.push(seule);
      message.reply("⚠️ Playlist non supportée, lecture de la 1ʳᵉ vidéo.");
    }
  } else {
    q.tracks.push(url);
    message.reply(`➕ Ajouté : ${url}`);
  }

  // Si pas encore en cours, rejoindre et lancer
  return joinAndPlay(guildId);
}

//////////////////////
// Join & lancer play
//////////////////////
async function joinAndPlay(guildId) {
  const q = queues.get(guildId);
  if (q.player.state.status === AudioPlayerStatus.Idle) {
    if (!q.voiceChannel) {
      return q.textChannel.send("🔊 Rejoignez d’abord un salon vocal.");
    }
    try {
      const conn = joinVoiceChannel({
        channelId: q.voiceChannel.id,
        guildId,
        adapterCreator: q.voiceChannel.guild.voiceAdapterCreator,
      });
      conn.subscribe(q.player);
      await playNext(guildId);
    } catch (err) {
      log(NIVEAUX.ERROR, `Échec connexion vocale : ${err.message}`);
      q.textChannel.send("❌ Impossible de rejoindre le salon vocal.");
    }
  }
}

//////////////////////
// Lecture suivante
//////////////////////
async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q.tracks.length) return;

  const url = q.tracks[0];
  log(NIVEAUX.PLAY, `Lecture ${url}`);
  try {
    const opts = cookieHeader
      ? { requestOptions: { headers: { cookie: cookieHeader } } }
      : {};
    const { stream, type } = await playdl.stream(url, opts);
    const resource = createAudioResource(stream, { inputType: type, inlineVolume: true });
    resource.volume.setVolume(q.volume);
    q.resource = resource;
    q.player.play(resource);
    q.textChannel.send(`▶️ Lecture : ${url}`);
  } catch (err) {
    log(NIVEAUX.ERROR, `Erreur stream : ${err.message}`);
    q.textChannel.send(`❌ Erreur de lecture : ${err.message}`);
    q.tracks.shift();
    if (q.tracks.length) playNext(guildId);
  }
}

//////////////////////
// Connexion Discord
//////////////////////
client.login(DISCORD_TOKEN);
