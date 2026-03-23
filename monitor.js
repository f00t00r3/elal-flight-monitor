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

  const newState = {};
  const MISS_THRESHOLD = 3; // Only report "gone" after 3 consecutive misses

  // Build per-flight state
  for (const [date, flights] of Object.entries(flightsByDate)) {
    for (const flight of flights) {
      if (!flight.economy) continue;
      const key = `${date}|${flight.flight}|${flight.from}`;
      newState[key] = { ...flight, date, lastSeen: ts, missCount: 0 };
    }
  }

  // For flights in prev state but not in current results, carry forward with increased missCount
  for (const [key, prev] of Object.entries(prevState)) {
    if (!newState[key]) {
      const missCount = (prev.missCount || 0) + 1;
      if (missCount < MISS_THRESHOLD) {
        // Keep in state - likely a scrape failure, not actually gone
        newState[key] = { ...prev, missCount };
      }
      // If missCount >= MISS_THRESHOLD, don't carry forward (truly gone)
    }
  }

  // Build per-date change summary using confirmed state only
  const dateChanges = {};
  for (let day = 12; day <= 30; day++) {
    const date = `2026-04-${String(day).padStart(2, '0')}`;
    const dayLabel = `Apr ${day}`;

    // Current confirmed flights (missCount === 0 means seen this run)
    const curForDate = Object.entries(newState)
      .filter(([k, v]) => k.startsWith(date + '|') && v.missCount === 0)
      .map(([, v]) => v);

    // Previous confirmed flights (missCount === 0 last run)
    const prevForDate = Object.entries(prevState)
      .filter(([k, v]) => k.startsWith(date + '|') && (v.missCount || 0) === 0)
      .map(([, v]) => v);

    const prevCheapest = prevForDate.length > 0 ? Math.min(...prevForDate.map(f => f.economy).filter(p => p)) : null;
    const curCheapest = curForDate.length > 0 ? Math.min(...curForDate.map(f => f.economy).filter(p => p)) : null;
    const cheapFlight = curForDate.find(f => f.economy === curCheapest);

    // Truly gone = was in prev AND now exceeded miss threshold
    const trulyGone = prevForDate.length > 0 && curForDate.length === 0 &&
      Object.entries(prevState).filter(([k]) => k.startsWith(date + '|'))
        .every(([k, v]) => !newState[k] || newState[k].missCount >= MISS_THRESHOLD - 1);

    if (curForDate.length > 0 && prevForDate.length === 0) {
      const fire = curCheapest < PRICE_THRESHOLD ? ' 🔥' : '';
      dateChanges[date] = `${dayLabel}: ${curForDate.length} new flights, cheapest $${curCheapest} (${cheapFlight.from} ${cheapFlight.dep})${fire}`;
    } else if (trulyGone) {
      dateChanges[date] = `${dayLabel}: all flights gone (was $${prevCheapest})`;
    } else if (curCheapest && prevCheapest && curCheapest < prevCheapest) {
      const fire = curCheapest < PRICE_THRESHOLD ? ' 🔥' : '';
      dateChanges[date] = `${dayLabel}: PRICE DROP $${prevCheapest} -> $${curCheapest} (${cheapFlight.from} ${cheapFlight.dep})${fire}`;
    } else if (curCheapest && prevCheapest && curCheapest > prevCheapest) {
      const fire = curCheapest < PRICE_THRESHOLD ? ' 🔥' : '';
      dateChanges[date] = `${dayLabel}: PRICE UP $${prevCheapest} -> $${curCheapest}${fire}`;
    }
  }

  saveState(newState);
  const changes = Object.values(dateChanges);

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
    console.log(`\n  ${changes.length} date(s) changed:`);
    changes.forEach(c => console.log(`    ${c}`));

    await sendNtfy(`El Al NYC->TLV: ${changes.length} update(s)`, changes.join('\n'));
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
