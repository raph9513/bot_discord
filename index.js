require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
} = require('@discordjs/voice');
const play = require('play-dl');

const { DISCORD_TOKEN, PREFIX } = process.env;

if (!DISCORD_TOKEN || !PREFIX) {
  console.error('❌ Il faut définir DISCORD_TOKEN et PREFIX en config vars !');
  process.exit(1);
}

// Client Discord v14 avec les intents nécessaires
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// File d'attente par serveur : { player, tracks, voiceChannel, textChannel, volume, currentResource }
const queues = new Map();

client.once('ready', () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  const [cmd, ...rest] = message.content
    .slice(PREFIX.length)
    .trim()
    .split(/ +/);
  const guildId = message.guild.id;

  // Initialisation de la queue pour ce serveur
  if (!queues.has(guildId)) {
    const player = createAudioPlayer();
    queues.set(guildId, {
      player,
      tracks: [],
      voiceChannel: null,
      textChannel: null,
      volume: 1.0,
      currentResource: null,
    });
    // Quand la musique se termine, lire la suivante ou quitter
    player.on(AudioPlayerStatus.Idle, () => {
      const q = queues.get(guildId);
      if (!q) return;
      q.tracks.shift();
      if (q.tracks.length) return playNext(guildId);
      getVoiceConnection(guildId)?.destroy();
      queues.delete(guildId);
    });
  }

  const queue = queues.get(guildId);

  switch (cmd.toLowerCase()) {
    case 'play': {
      let url = rest[0];
      if (!url || !url.startsWith('http')) {
        return message.reply('❌ Donne une URL YouTube valide.');
      }

      // Si c'est une playlist YouTube, on récupère la liste des vidéos via play-dl
      if (url.includes('list=')) {
        try {
          // `playlist_info` retourne un objet YouTubePlayList avec une propriété `videos`:contentReference[oaicite:0]{index=0}.
          const playlist = await play.playlist_info(url, { incomplete: true });
          let videos = playlist.videos || [];
          const MAX = 20;
          if (videos.length > MAX) {
            videos = videos.slice(0, MAX);
            message.channel.send(`⚠️ Playlist tronquée : ${MAX} premières vidéos.`);
          }
          if (!videos.length) {
            return message.reply('❌ Impossible de lister la playlist.');
          }
          videos.forEach((v) => queue.tracks.push(v.url));
          message.channel.send(`➕ ${videos.length} vidéos ajoutées à la file.`);
        } catch (err) {
          console.error('Failed to get playlist info:', err);
          return message.reply('❌ Impossible de lire la playlist.');
        }
      } else {
        // Sinon on ajoute simplement l'URL
        queue.tracks.push(url);
        message.channel.send(`➕ Ajouté à la file : ${url}`);
      }

      // Paramétrage des canaux
      queue.voiceChannel = message.member.voice.channel;
      queue.textChannel = message.channel;

      // Si rien ne joue, rejoindre le salon vocal et lancer la lecture
      if (queue.player.state.status !== AudioPlayerStatus.Playing) {
        if (!queue.voiceChannel) {
          return message.reply('🔊 Tu dois être dans un salon vocal.');
        }
        const conn = joinVoiceChannel({
          channelId: queue.voiceChannel.id,
          guildId,
          adapterCreator: message.guild.voiceAdapterCreator,
        });
        conn.subscribe(queue.player);
        await playNext(guildId);
      }
      break;
    }

    case 'pause':
      queue.player.pause();
      return message.reply('⏸️ Lecture mise en pause.');

    case 'resume':
      queue.player.unpause();
      return message.reply('▶️ Lecture reprise.');

    case 'skip':
      queue.player.stop();
      return message.reply('⏭️ Piste suivante.');

    case 'stop':
      queue.tracks = [];
      queue.player.stop();
      getVoiceConnection(guildId)?.destroy();
      queues.delete(guildId);
      return message.reply('⏹️ Lecture arrêtée et file vidée.');

    case 'queue':
      if (!queue.tracks.length) return message.reply('📭 La file est vide.');
      return message.channel.send(
        '🎶 File d’attente :\n' +
          queue.tracks.map((u, i) => `${i + 1}. ${u}`).join('\n')
      );

    case 'volume': {
      const v = parseInt(rest[0], 10);
      if (isNaN(v) || v < 0 || v > 100) {
        return message.reply('❌ Usage : volume 0–100');
      }
      queue.volume = v / 100;
      if (queue.currentResource?.volume) {
        queue.currentResource.volume.setVolume(queue.volume);
      }
      return message.reply(`🔊 Volume : ${v}%`);
    }

    case 'clear': {
      const amt = parseInt(rest[0], 10);
      if (isNaN(amt) || amt < 1 || amt > 100) {
        return message.reply('❌ Entre 1 et 100.');
      }
      await message.channel.bulkDelete(amt, true);
      const c = await message.channel.send(`🧹 ${amt} messages supprimés.`);
      setTimeout(() => c.delete().catch(() => {}), 5000);
      break;
    }

    case 'all':
      return message.channel.send(`
📜 **Commandes :**
${PREFIX}play <URL>      — Joue (vidéo ou playlist)  
${PREFIX}pause          — Met en pause  
${PREFIX}resume         — Reprendre  
${PREFIX}skip           — Passer  
${PREFIX}stop           — Arrêter + vider  
${PREFIX}queue          — Afficher la file  
${PREFIX}volume <0–100> — Régler le volume  
${PREFIX}clear <n>      — Supprimer n messages  
${PREFIX}all            — Aide  
      `);

    default:
      return message.reply('❓ Tape `all` pour la liste des commandes.');
  }
});

/**
 * Lit la première URL de la file en utilisant play-dl pour créer un flux audio.
 * Si une erreur survient lors de la création du flux, la piste est ignorée.
 *
 * @param {string} guildId ID du serveur dont on lit la file
 */
async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q?.tracks.length) return;
  const url = q.tracks[0];
  try {
    // play.stream fournit un objet { stream, type } prêt pour discord.js:contentReference[oaicite:1]{index=1}.
    const stream = await play.stream(url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true,
    });
    resource.volume.setVolume(q.volume);
    q.currentResource = resource;
    q.player.play(resource);
    q.textChannel.send(`▶️ Lecture : ${url}`);
  } catch (err) {
    console.error('play-dl stream error:', err);
    q.textChannel.send('❌ Erreur sur : ' + url);
    q.tracks.shift();
    if (q.tracks.length) playNext(guildId);
  }
}

client.login(DISCORD_TOKEN);
