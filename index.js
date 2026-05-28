// index.js
import 'dotenv/config';
import http from 'http';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { analyzePurchaseCandidate, generateMonthlySummaryDialogue } from './gemini.js';
import { savePurchaseToNotion, getCurrentMonthTotal } from './notion.js';
import { request } from 'undici';

const {
  DISCORD_TOKEN,
  SYSTEM_TIMEZONE = 'Asia/Tokyo',
  MAX_IMAGE_BYTES = '10485760',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    const content = message.content?.trim() || '';
    const isShushiQuery = /収支/.test(content); // 「収支」「今月の収支」など

    if (isShushiQuery) {
      await message.channel.sendTyping();
      // 要件3: 今月の合計をNotionから取得
      const { total, monthLabel } = await getCurrentMonthTotal();
      const dialogue = await generateMonthlySummaryDialogue({
        totalJPY: total,
        monthLabel,
      });

      const jpy = new Intl.NumberFormat('ja-JP', {
        style: 'currency',
        currency: 'JPY',
        maximumFractionDigits: 0,
      }).format(total);

      const out = [
        `【${monthLabel}の合計支出】${jpy}`,
        '',
        dialogue,
      ].join('\n');

      await message.reply(out);
      return;
    }

    // 通常のスクショ/テキスト解析フロー
    const hasImage =
      message.attachments.size > 0 &&
      [...message.attachments.values()].some((att) =>
        (att.contentType || '').startsWith('image/')
      );

    let userText = content;
    let imageBuffer = null;
    let imageMime = null;

    if (hasImage) {
      const imageAtt = [...message.attachments.values()].find((att) =>
        (att.contentType || '').startsWith('image/')
      );
      if (imageAtt) {
        if (Number(imageAtt.size) > Number(MAX_IMAGE_BYTES)) {
          await message.reply(
            `画像サイズが大きすぎます（上限 ${Math.floor(
              Number(MAX_IMAGE_BYTES) / (1024 * 1024)
            )}MB）。縮小して再送してください。`
          );
          return;
        }
        const res = await request(imageAtt.url);
        if (res.statusCode !== 200) {
          await message.reply('画像の取得に失敗しました。もう一度お試しください。');
          return;
        }
        imageBuffer = Buffer.from(await res.body.arrayBuffer());
        imageMime = imageAtt.contentType || 'image/png';
      }
    }

    if (!hasImage && !userText) return;

    await message.channel.sendTyping();

    // Gemini解析
    const result = await analyzePurchaseCandidate({
      text: userText,
      image: imageBuffer ? { bytes: imageBuffer, mimeType: imageMime } : null,
      options: { timezone: SYSTEM_TIMEZONE },
    });

    // Discord返信
    const lines = [];
    if (result.itemName) lines.push(`【商品名】${result.itemName}`);
    if (typeof result.price === 'number' && !Number.isNaN(result.price)) {
      const jpy = new Intl.NumberFormat('ja-JP', {
        style: 'currency',
        currency: 'JPY',
        maximumFractionDigits: 0,
      }).format(result.price);
      lines.push(`【金額】${jpy}`);
    }
    if (result.message) lines.push(`\n${result.message}`);

    const out =
      lines.length > 0
        ? lines.join('\n')
        : '解析できませんでした。もう少しはっきり写った画像か、テキストを送ってください。';

    const replyMsg = await message.reply(out);

    // Notion保存（失敗してもBot継続）
    try {
      const discordMessageUrl = buildDiscordMessageUrl({
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
      });

      await savePurchaseToNotion({
        itemName: result.itemName || '',
        price: Number.isFinite(result.price) ? result.price : 0,
        message: result.message || '',
        meta: {
          username: message.author.username,
          userId: message.author.id,
          channelId: message.channelId,
          discordMessageUrl,
        },
      });

      await replyMsg.react('✅');
    } catch (e) {
      console.error('Notion save failed:', e);
      await replyMsg.react('⚠️');
    }
  } catch (err) {
    console.error(err);
    await message.reply('処理中にエラーが発生しました。時間をおいて再度お試しください。');
  }
});

function buildDiscordMessageUrl({ guildId, channelId, messageId }) {
  if (!guildId) return `[discord.com](https://discord.com/channels/@me/${channelId}/${messageId})`;
  return `[discord.com](https://discord.com/channels/${guildId}/${channelId}/${messageId})`;
}

client.login(DISCORD_TOKEN);
// Render審査通過用の最強ダミーサーバー
const port = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Bot is active!\n');
}).listen(port, '0.0.0.0', () => {
  console.log('Web Server is listening on port ' + port);
});