require("dotenv").config();
const express = require("express");
const playdl = require("play-dl");

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

const {
  DISCORD_TOKEN,
  PREFIX,
  COOKIE_PATH = "./cookies.json",
  USE_COOKIES = "true",
  PORT = 8080,
} = process.env;

if (USE_COOKIES.toLowerCase() === "true") {
  try {
    const cookies = require(COOKIE_PATH);
    playdl.setToken({ cookies });
    console.log("[INFO] Cookies chargées depuis", COOKIE_PATH);
  } catch (err) {
    console.warn("[WARN] Impossible de charger les cookies:", err.message);
  }
}

// ─── Vérifications de base ───────────────────────────────────────────
if (!DISCORD_TOKEN || !PREFIX) {
  console.error("[ERROR] Il faut définir DISCORD_TOKEN et PREFIX !");
  process.exit(1);
}

// ─── Server keep‑alive ────────────────────────────────────────────────
const app = express();
app.get("/", (_req, res) => res.send("🤖 Bot is alive"));
const server = app.listen(PORT, () => {
  console.log(`[INFO] Keep‑alive server on port ${PORT}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[WARN] Port ${PORT} déjà utilisé, skip keep‑alive.`);
  } else {
    throw err;
  }
});

// ─── Chargement cookies pour play‑dl ─────────────────────────────────
if (USE_COOKIES.toLowerCase() === "true") {
  try {
    playdl.setToken({ cookies: require(COOKIE_PATH) });
    console.log(`[INFO] Cookies chargées depuis ${COOKIE_PATH}`);
  } catch {
    console.warn("[WARN] Impossible de charger les cookies — lecture non authentifiée.");
  }
}

// ─── Bot Discord ─────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const queues = new Map(); // guildId → { player, tracks, voiceChannel, textChannel, volume, resource }

client.once("ready", () => {
  console.log(`[INFO] Connected as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  const [cmd, ...args] = message.content
    .slice(PREFIX.length)
    .trim()
    .split(/\s+/);
  const guildId = message.guild.id;

  // initialise queue
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

  switch (cmd.toLowerCase()) {
    case "play":
      return handlePlay(message, args[0] || "");

    case "pause":
      q.player.pause();
      return message.reply("⏸️ Lecture mise en pause.");

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
      return message.reply("⏹️ Arrêt et file vidée.");

    case "queue":
      if (!q.tracks.length) return message.reply("📭 File vide.");
      return message.channel.send(
        "🎶 File d'attente :\n" +
          q.tracks.map((u, i) => `${i + 1}. ${u}`).join("\n")
      );

    case "volume": {
      const v = parseInt(args[0], 10);
      if (isNaN(v) || v < 0 || v > 100) {
        return message.reply("❌ Usage: volume 0–100");
      }
      q.volume = v / 100;
      if (q.resource?.volume) q.resource.volume.setVolume(q.volume);
      return message.reply(`🔊 Volume réglé à ${v}%`);
    }

    case "all":
      return message.channel.send(`
📜 **Commandes** :
${PREFIX}play <URL> – Joue vidéo ou playlist  
${PREFIX}pause        – Pause  
${PREFIX}resume       – Reprendre  
${PREFIX}skip         – Passer  
${PREFIX}stop         – Arrêter + vider  
${PREFIX}queue        – Afficher file  
${PREFIX}volume <0‑100> – Régler volume  
${PREFIX}all          – Aide  
      `);

    default:
      return message.reply("❓ Tapez `all` pour la liste des commandes.");
  }
});

async function handlePlay(message, url) {
  const guildId = message.guild.id;
  const q = queues.get(guildId);

  if (!url || !url.startsWith("http")) {
    return message.reply("❌ URL YouTube invalide.");
  }

  q.voiceChannel = message.member.voice.channel;
  q.textChannel = message.channel;

  // playlist ?
  if (url.includes("list=")) {
    console.log(`[YT-PLAYLIST] Expanding ${url}`);
    let vids;
    try {
      const pl = await playdl.playlist_info(url, { incomplete: true });
      vids = pl.videos.slice(0, 20);
    } catch (err) {
      console.error(`[YT-PLAYLIST] Erreur: ${err.message}`);
      // fallback single
      q.tracks.push(url.split("&")[0]);
      message.reply("⚠️ Mix non supporté, lecture vidéo seule.");
      return joinAndPlay(guildId);
    }
    vids.forEach((v) => q.tracks.push(v.url));
    message.reply(`➕ ${vids.length} vidéos ajoutées.`);
    return joinAndPlay(guildId);
  }

  // simple vidéo
  q.tracks.push(url);
  message.reply(`➕ Ajouté : ${url}`);
  return joinAndPlay(guildId);
}

async function joinAndPlay(guildId) {
  const q = queues.get(guildId);
  if (q.player.state.status === AudioPlayerStatus.Idle) {
    if (!q.voiceChannel) return q.textChannel.send("🔊 Rejoignez d'abord un salon vocal.");
    try {
      const conn = joinVoiceChannel({
        channelId: q.voiceChannel.id,
        guildId,
        adapterCreator: q.voiceChannel.guild.voiceAdapterCreator,
      });
      conn.subscribe(q.player);
      await playNext(guildId);
    } catch (err) {
      console.error(`[VOICE JOIN] ${err.message}`);
      q.textChannel.send("❌ Impossible de rejoindre le salon vocal.");
    }
  }
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q?.tracks.length) return;

  const url = q.tracks[0];
  console.log(`[PLAY] streaming ${url}`);
  try {
    const { stream, type } = await playdl.stream(url);
    const resource = createAudioResource(stream, { inputType: type, inlineVolume: true });
    resource.volume.setVolume(q.volume);
    q.resource = resource;
    q.player.play(resource);
    q.textChannel.send(`▶️ Lecture : ${url}`);
  } catch (err) {
    console.error(`[ERROR] playdl.stream: ${err.message}`);
    q.textChannel.send("❌ Erreur de streaming : " + err.message);
    q.tracks.shift();
    if (q.tracks.length) playNext(guildId);
  }
}

client.login(DISCORD_TOKEN);
