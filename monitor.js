const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const https = require('https');
const fs = require('fs');
const path = require('path');

const NTFY_TOPIC = process.env.NTFY_TOPIC || 'elflight';
const STATE_FILE = path.join(__dirname, 'elal-nyc-state.json');
const PRICE_THRESHOLD = 1000;

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function sendNtfy(title, message) {
  const payload = JSON.stringify({ topic: NTFY_TOPIC, title, message, priority: 5, tags: ['airplane', 'rotating_light'] });
  return new Promise((resolve) => {
    const req = https.request('https://ntfy.sh', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log(`  [NTFY] ${res.statusCode}`); resolve(); }); });
    req.on('error', () => resolve()); req.write(payload); req.end();
  });
}

function collectOutbound(text) {
  try {
    const data = JSON.parse(text);
    const bounds = [
      ...(data.data?.trip?.outbound?.directBounds?.bounds || []),
      ...(data.data?.trip?.outbound?.indirectBounds?.bounds || [])
    ];
    return bounds.map(b => {
      const seg = b.segments?.[0];
      return seg ? {
        flight: `LY${seg.id?.split('_')[0]}`,
        from: seg.departureAirport?.code,
        dep: seg.departureDate?.substring(11, 16),
        arr: seg.arrivalDate?.substring(11, 16),
        economy: b.fares?.[0]?.netPrice?.cash?.amount || null,
        date: seg.departureDate?.substring(0, 10)
      } : null;
    }).filter(Boolean);
  } catch { return []; }
}

async function searchDate(ignoredBrowser, day) {
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  let outboundText = null;
  page.on('response', async (response) => {
    if (response.url().includes('search/cash/outbound')) {
      try { outboundText = await response.text(); } catch {}
    }
  });

  try {
    await page.goto('https://www.elal.com/heb/israel', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 8000));

    const clickBtn = async (l) => {
      await page.evaluate((l) => { const w = document.querySelector('search-widget'); for (const b of w.querySelectorAll('button')) if (b.getAttribute('aria-label') === l) { b.click(); return; } }, l);
      await new Promise(r => setTimeout(r, 200));
    };

    // Passengers
    const p = await page.$('search-widget #passenger-counters-input');
    if (!p) { await page.close(); return null; }
    await p.click(); await new Promise(r => setTimeout(r, 600));
    await clickBtn('העלה מבוגר'); await clickBtn('העלה ילד'); await clickBtn('העלה ילד');
    await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 200));

    // One-way
    await page.evaluate(() => { const w = document.querySelector('search-widget'); for (const e of w.querySelectorAll('*')) if (e.textContent.trim() === 'כיוון אחד' && !e.children.length) { e.click(); return; } }); await new Promise(r => setTimeout(r, 600));

    // NYC
    const oi = await page.$('search-widget #outbound-origin-location-input');
    await oi.click({ clickCount: 3 }); await oi.type('NYC', { delay: 60 }); await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => { const w = document.querySelector('search-widget'); for (const o of w.querySelectorAll('[role="option"], li')) if (o.textContent.includes('NYC')) { o.click(); return; } }); await new Promise(r => setTimeout(r, 600));

    // TLV
    const di = await page.$('search-widget #outbound-destination-location-input');
    await di.click(); await di.type('TLV', { delay: 60 }); await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => { const w = document.querySelector('search-widget'); const o = w.querySelectorAll('[role="option"], li'); if (o.length) o[0].click(); }); await new Promise(r => setTimeout(r, 1200));

    // April + day
    await page.evaluate(() => { const w = document.querySelector('search-widget'); for (const e of w.querySelectorAll('*')) if (e.textContent.trim() === 'אפר' && !e.children.length) { e.click(); return; } }); await new Promise(r => setTimeout(r, 1200));
    await page.evaluate((d) => { const w = document.querySelector('search-widget'); for (const el of w.querySelectorAll('[class*="day"]')) if (el.textContent.trim().startsWith(String(d))) { el.click(); return; } }, day); await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => { const w = document.querySelector('search-widget'); for (const b of w.querySelectorAll('button')) if (b.textContent.trim() === 'אישור') { b.click(); return; } }); await new Promise(r => setTimeout(r, 500));

    // Submit
    await page.evaluate(() => { const w = document.querySelector('search-widget'); const b = w.querySelector('button[type="submit"]'); if (b) b.click(); });
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 10000));

    return outboundText ? collectOutbound(outboundText) : null;
  } catch {
    return null;
  } finally {
    await browser.close();
  }
}

async function scrape() {
  const allFlights = {};
  for (let day = 12; day <= 30; day++) {
    const date = `2026-04-${String(day).padStart(2, '0')}`;
    const flights = await searchDate(null, day);

    if (flights && flights.length > 0) {
      allFlights[date] = flights;
      const cheapest = Math.min(...flights.map(f => f.economy).filter(p => p));
      console.log(`  Apr ${day}: ${flights.length} flights, cheapest $${cheapest}`);
    } else {
      console.log(`  Apr ${day}: no flights`);
    }
  }

  return allFlights;
}

async function main() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Checking El Al NYC->TLV Apr 12-30...`);

  const prevState = loadState();
  let flightsByDate;
  try { flightsByDate = await scrape(); }
  catch (err) { console.error('  Scrape error:', err.message); process.exit(1); }

  const changes = [];
  const newState = {};

  for (const [date, flights] of Object.entries(flightsByDate)) {
    for (const flight of flights) {
      if (!flight.economy) continue;
      const key = `${date}|${flight.flight}|${flight.from}`;
      const prev = prevState[key];
      newState[key] = { ...flight, date, lastSeen: ts };

      const day = date.substring(5).replace('-', '/');

      if (!prev) {
        changes.push({ type: 'new', msg: `NEW: ${day} ${flight.flight} ${flight.from} ${flight.dep} $${flight.economy}` });
      } else if (flight.economy < prev.economy) {
        changes.push({ type: 'drop', msg: `PRICE DROP: ${day} ${flight.flight} $${prev.economy} -> $${flight.economy}` });
      } else if (flight.economy > prev.economy) {
        changes.push({ type: 'up', msg: `PRICE UP: ${day} ${flight.flight} $${prev.economy} -> $${flight.economy}` });
      }

      if (flight.economy < PRICE_THRESHOLD && (!prev || prev.economy >= PRICE_THRESHOLD))
        changes.push({ type: 'under', msg: `UNDER $${PRICE_THRESHOLD}! ${day} ${flight.flight} ${flight.from} ${flight.dep} $${flight.economy}` });
    }
  }

  // Check for removed flights
  for (const [key, prev] of Object.entries(prevState)) {
    if (!newState[key]) {
      const day = prev.date.substring(5).replace('-', '/');
      changes.push({ type: 'gone', msg: `GONE: ${day} ${prev.flight} ${prev.from} (was $${prev.economy})` });
    }
  }

  saveState(newState);

  // Build daily summary
  const noFlightDays = [];
  const summaryLines = [];
  for (let day = 12; day <= 30; day++) {
    const date = `2026-04-${String(day).padStart(2, '0')}`;
    const flights = flightsByDate[date];
    if (!flights || flights.length === 0) {
      noFlightDays.push(day);
      continue;
    }
    const cheapest = Math.min(...flights.map(f => f.economy).filter(p => p));
    const cheapFlight = flights.find(f => f.economy === cheapest);
    const marker = cheapest < PRICE_THRESHOLD ? ' 🔥' : '';
    summaryLines.push(`Apr ${day}: $${cheapest} (${cheapFlight.from} ${cheapFlight.dep})${marker}`);
  }

  const summary = `El Al NYC->TLV | 2 ADT + 2 CHD\n\n` +
    (summaryLines.length > 0 ? summaryLines.join('\n') : 'No flights available on any date.');

  console.log(`\n${summary}`);

  if (changes.length > 0) {
    console.log(`\n  ${changes.length} changes:`);
    changes.forEach(c => console.log(`    ${c.msg}`));

    // Send changes alert only (no separate summary)
    const changeMsg = changes.map(c => c.msg).join('\n');
    await sendNtfy(`El Al NYC->TLV: ${changes.length} change(s)!`, changeMsg);
  } else {
    console.log('  No changes.');
    // Send daily summary at 9am EST (14:00 UTC)
    const nowUTC = new Date();
    const estHour = (nowUTC.getUTCHours() - 5 + 24) % 24;
    const estMin = nowUTC.getUTCMinutes();
    const summaryFile = path.join(__dirname, 'elal-nyc-lastsummary.txt');
    let lastSummaryDate = '';
    try { lastSummaryDate = fs.readFileSync(summaryFile, 'utf8').trim(); } catch {}
    const todayStr = nowUTC.toISOString().substring(0, 10);
    if (estHour >= 9 && lastSummaryDate !== todayStr) {
      await sendNtfy('El Al NYC->TLV: Daily Summary', summary);
      fs.writeFileSync(summaryFile, todayStr);
      console.log('  Sent daily summary (9am EST).');
    }
  }
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
