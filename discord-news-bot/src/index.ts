import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  Message,
} from 'discord.js';
import OpenAI from 'openai';
import NewsAPI from 'newsapi';
import cron from 'node-cron';

/* ----------------------------- utils ----------------------------- */
const log       = (...a: unknown[]) => console.log('[AI-News-Bot]', ...a);
const logError  = (where: string, err: unknown) =>
  console.error(`[AI-News-Bot][ERROR][${where}]`, err);
const toJSTDate = (iso: string) =>
  new Date(iso).toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year : 'numeric',
    month: '2-digit',
    day  : '2-digit',
  });
const summarize = async (articles: Article[]): Promise<string> => {
  try {
    const promptBody = articles
      .map((a, i) => `【${i + 1}】${a.title}\n${a.description ?? ''}`)
      .join('\n\n');
    const res = await openai.chat.completions.create({
      model   : 'gpt-4o',
      messages: [
        {
          role   : 'user',
          content:
            '次の複数記事を日本語 200 字以内で分かりやすく要約し、' +
            '箇条書きでポイントを整理してください。\n\n' +
            promptBody,
        },
      ],
      max_tokens: 400,
    });
    return res.choices[0].message.content?.trim() ?? '';
  } catch (e) {
    logError('summarize', e);
    return '⚠️ 要約に失敗しました';
  }
};

const makeArticleList = (articles: Article[]): string =>
  articles
    .map(
      (a, i) => `【${i + 1}】${toJSTDate(a.publishedAt)} ｜ ${a.url}`,
    )
    .join('\n');

/* 🔹 メンションをすべて除去 */
const stripMentions = (txt: string) =>
  txt
    .replace(/<@!?[0-9]+>/g, '')
    .replace(/<@&[0-9]+>/g, '')
    .replace(/<#(?:[0-9]+)>/g, '')
    .trim();

/* --------------------- env & client sanity check ------------------ */
['DISCORD_TOKEN', 'TARGET_CHANNEL_ID', 'OPENAI_API_KEY', 'NEWS_API_KEY']
  .forEach((k) => !process.env[k] && log(`⚠️  ${k} が未設定`));

const client  = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const newsapi = new NewsAPI(process.env.NEWS_API_KEY!);

/* ----------------------------- types ------------------------------ */
interface Article {
  title: string;
  description?: string | null;
  url: string;
  publishedAt: string;
}
/* --------------------------- helpers ------------------------------ */
// fetchNews を汎用化。aiFilter が true なら AI 専用検索＆英語固定
const fetchNews = async (
  query: string,
  pageSize = 5,
  opts: { aiFilter?: boolean } = { aiFilter: true },
): Promise<Article[]> => {
  try {
    const q = opts.aiFilter
      ? `${query} AND (AI OR "artificial intelligence" OR GenerativeAI)`
      : query;

    // AI 専用以外は language を指定しない
    const params: Record<string, any> = {
      q,
      sortBy: 'publishedAt',
      pageSize,
    };
    if (opts.aiFilter) params.language = 'en';

    log(`Fetching news: "${q}"`);
    const { articles } = (await newsapi.v2.everything(params)) as {
      articles: Article[];
    };
    log(`Fetched ${articles?.length ?? 0} articles`);
    return articles ?? [];
  } catch (e) {
    logError('fetchNews', e);
    return [];
  }
};

/* --------------------- compose & send ---------------------------- */
async function composeAndSend(
  target: TextChannel | Message<boolean>,
  theme = 'AI',
  aiFilter = true,
): Promise<void> {
  const articles = await fetchNews(theme, 5, { aiFilter });
  if (articles.length === 0) {
    if ('send' in target)
      await target.send('本日のニュースは見つかりませんでした。');
    else
      await target.reply('関連ニュースが見つかりませんでした。');
    return;
  }

  const summary  = await summarize(articles);
  const listPart = makeArticleList(articles);

  const header = aiFilter
    ? '📰 今日の AI ニュースまとめ'
    : `📰 **${theme}** に関する最新ニュースまとめ`;

  const message =
    `${header}\n${summary}\n` +
    '──────────────\n' +
    listPart;

  if ('send' in target) {
    const sent = await target.send(message);
    await sent.suppressEmbeds(true);  
  } else {
    const sent = await target.reply(message);
    await sent.suppressEmbeds(true);
  }
}

/* --------------------------- schedule ----------------------------- */
cron.schedule(
  '0 0 * * *',
  async () => {
    log('Cron job fired (daily news)');
    const ch = client.channels.cache.get(
      process.env.TARGET_CHANNEL_ID!,
    ) as TextChannel | undefined;
    if (ch) await composeAndSend(ch, 'AI', true);
    else     logError('cron', 'ターゲットチャンネルが見つかりません');
  },
  { timezone: 'Asia/Tokyo' },
);

/* --------------------------- message ------------------------------ */
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (msg.channelId !== process.env.TARGET_CHANNEL_ID) return;

  const theme = stripMentions(msg.content).trim();
  if (!theme) return;

  log(`Theme received: "${theme}" from ${msg.author.tag}`);
  await composeAndSend(msg, theme, false);
});

/* ---------------------------- boot ------------------------------- */
client.once('ready', () => log(`Logged in as ${client.user?.tag}`));
client.login(process.env.DISCORD_TOKEN).catch((e) => logError('login', e));
