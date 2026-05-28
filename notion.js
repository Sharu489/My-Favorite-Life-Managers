// notion.js
import 'dotenv/config';
import { Client } from '@notionhq/client';

const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;

if (!NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN in .env');
  process.exit(1);
}
if (!NOTION_DATABASE_ID) {
  console.error('Missing NOTION_DATABASE_ID in .env');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// 1. 家計簿の1行作成（ここは正常に動いているのでそのまま）
export async function savePurchaseToNotion({ itemName, price, message }) {
  const safeItemName = (itemName && itemName.trim()) || '(不明な商品)';
  const safePrice = Number.isFinite(price) ? Math.max(0, Math.floor(price)) : 0;
  const dateISO = todayISO();

  const created = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      '商品名': { title: [{ type: 'text', text: { content: safeItemName } }] },
      '金額': { number: safePrice },
      '日付': { date: { start: dateISO } },
    },
    children: [
      {
        object: 'block',
        heading_2: { rich_text: [{ type: 'text', text: { content: '検問ログ（ジン＆セレン）' } }] },
      },
      {
        object: 'block',
        paragraph: { rich_text: [{ type: 'text', text: { content: `商品名: ${safeItemName}` } }] },
      },
      {
        object: 'block',
        paragraph: { rich_text: [{ type: 'text', text: { content: `金額: ${safePrice} 円` } }] },
      },
      {
        object: 'block',
        paragraph: { rich_text: [{ type: 'text', text: { content: `日付: ${dateISO}` } }] },
      },
    ],
  });
  const pageId = created.id;

  const lines = String(message || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 0) {
    const children = [
      { object: 'block', divider: {} },
      { object: 'block', heading_3: { rich_text: [{ type: 'text', text: { content: '会話ログ' } }] } },
      ...lines.map((line) => ({
        object: 'block',
        paragraph: { rich_text: [{ type: 'text', text: { content: line } }] },
      })),
    ];
    await notion.blocks.children.append({ block_id: pageId, children });
  }
  return { pageId };
}

// 2. 今月の合計（バグるパッケージを捨てて、標準機能のfetchで直接通信する奥の手）
export async function getCurrentMonthTotal() {
  const { start, end } = currentMonthDateRange();
  let total = 0;
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const body = {
      filter: {
        and: [
          { property: '日付', date: { on_or_after: start } },
          { property: '日付', date: { on_or_before: end } },
          { property: '金額', number: { is_not_empty: true } },
        ],
      },
      sorts: [{ property: '日付', direction: 'ascending' }],
      page_size: 100,
    };

    if (startCursor) {
      body.start_cursor = startCursor;
    }

    // ここが直接通信！
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion API Error: ${res.status} ${errText}`);
    }

    const data = await res.json();

    for (const page of data.results) {
      const num = page.properties?.['金額']?.number;
      if (typeof num === 'number' && Number.isFinite(num)) {
        total += Math.max(0, Math.floor(num));
      }
    }
    hasMore = data.has_more === true;
    startCursor = data.next_cursor || undefined;
  }
  return { total, monthLabel: monthLabelForNow() };
}

// 日付ユーティリティ
function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function currentMonthDateRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const start = `${y}-${m}-01`;
  const end = todayISO();
  return { start, end };
}

function monthLabelForNow() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}年${m}月`;
}