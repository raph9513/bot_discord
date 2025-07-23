require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
} = require('@discordjs/voice');
const { spawnSync, spawn } = require('child_process');
const { DISCORD_TOKEN, PREFIX } = process.env;

if (!DISCORD_TOKEN || !PREFIX) {
  console.error("❌ Il faut définir DISCORD_TOKEN et PREFIX en config vars !");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Map guildId → { player, tracks[], voiceChannel, textChannel, volume, currentResource }
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

  // Initialise la file si besoin
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
    player.on(AudioPlayerStatus.Idle, () => {
      const q = queues.get(guildId);
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
      if (!url || !url.startsWith('http'))
        return message.reply('❌ Donne une URL YouTube valide.');

      // playlist ?
      if (url.includes('list=')) {
        const out = spawnSync(
          'yt-dlp',
          ['--flat-playlist', '--print', '%(id)s', url],
          { encoding: 'utf8' }
        ).stdout;
        let ids = out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l);
        const MAX = 20;
        if (ids.length > MAX) {
          ids = ids.slice(0, MAX);
          message.channel.send(`⚠️ Playlist tronquée : ${MAX} premières vidéos.`);
        }
        if (!ids.length)
          return message.reply('❌ Impossible de lister la playlist.');
        ids.forEach((id) =>
          queue.tracks.push(`https://www.youtube.com/watch?v=${id}`)
        );
        message.channel.send(`➕ ${ids.length} vidéos ajoutées à la file.`);
      } else {
        queue.tracks.push(url);
        message.channel.send(`➕ Ajouté à la file : ${url}`);
      }

      queue.voiceChannel = message.member.voice.channel;
      queue.textChannel = message.channel;

      if (queue.player.state.status !== AudioPlayerStatus.Playing) {
        if (!queue.voiceChannel)
          return message.reply('🔊 Tu dois être dans un salon vocal.');
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
        '🎶 File d\'attente :\n' +
          queue.tracks.map((u, i) => `${i + 1}. ${u}`).join('\n')
      );

    case 'volume': {
      const v = parseInt(rest[0], 10);
      if (isNaN(v) || v < 0 || v > 100)
        return message.reply('❌ Usage : volume 0–100');
      queue.volume = v / 100;
      if (queue.currentResource?.volume)
        queue.currentResource.volume.setVolume(queue.volume);
      return message.reply(`🔊 Volume : ${v}%`);
    }

    case 'clear': {
      const amt = parseInt(rest[0], 10);
      if (isNaN(amt) || amt < 1 || amt > 100)
        return message.reply('❌ Entre 1 et 100.');
      await message.channel.bulkDelete(amt, true);
      const c = await message.channel.send(`🧹 ${amt} messages supprimés.`);
      setTimeout(() => c.delete().catch(() => {}), 5000);
      break;
    }

    case 'all':
      return message.channel.send(`
📜 **Commandes :**
${PREFIX}play <URL>    — Joue (vidéo ou playlist)  
${PREFIX}pause        — Pause  
${PREFIX}resume       — Reprendre  
${PREFIX}skip         — Passer  
${PREFIX}stop         — Arrêter + vider  
${PREFIX}queue        — Afficher file  
${PREFIX}volume <0–100> — Volume  
${PREFIX}clear <n>    — Suppr. n messages  
${PREFIX}all          — Aide  
      `);

    default:
      return message.reply('❓ Tape `all` pour la liste.');
  }
});

function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q?.tracks.length) return;

  const url = q.tracks[0];
  const ytdlp = spawn(
    'yt-dlp',
    [
      '--format', 'bestaudio[ext=webm]/bestaudio',
      '--no-playlist',
      '--quiet',
      '--external-downloader', 'ffmpeg',
      '--external-downloader-args', '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5',
      '--output', '-',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );

  const resource = createAudioResource(ytdlp.stdout, {
    inputType: 'webm/opus',
    inlineVolume: true,
  });

  resource.volume.setVolume(q.volume);
  q.currentResource = resource;
  q.player.play(resource);
  q.textChannel.send(`▶️ Lecture : ${url}`);

  ytdlp.on('error', (err) => {
    console.error('yt-dlp error:', err);
    q.textChannel.send('❌ Erreur sur : ' + url);
    q.tracks.shift();
    if (q.tracks.length) playNext(guildId);
  });
}

client.login(DISCORD_TOKEN);
