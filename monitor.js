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
      if (!seg) return null;
      // Only care about economy. Skip Premium/Business flights entirely.
      const economyFare = b.fares?.find(f => f.bookingClassName === 'economy');
      if (!economyFare) return null;
      const price = economyFare.netPrice?.cash?.amount || null;
      if (!price) return null;
      return {
        flight: `LY${seg.id?.split('_')[0]}`,
        from: seg.departureAirport?.code,
        dep: seg.departureDate?.substring(11, 16),
        arr: seg.arrivalDate?.substring(11, 16),
        economy: price,
        date: seg.departureDate?.substring(0, 10)
      };
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

  // Simple approach: only compare dates where we GOT results this run.
  // If a date returned 0 flights, ignore it completely (likely scrape failure).
  // State only stores the last SUCCESSFUL scrape per date.
  const newState = { ...prevState }; // start with previous state

  const dateChanges = {};
  for (let day = 12; day <= 30; day++) {
    const date = `2026-04-${String(day).padStart(2, '0')}`;
    const dayLabel = `Apr ${day}`;
    const curFlights = (flightsByDate[date] || []).filter(f => f.economy);

    // If we got 0 results, track consecutive misses via a counter in state
    const missKey = `${date}|_misses`;
    if (curFlights.length === 0) {
      const prevMisses = prevState[missKey]?.count || 0;
      const hadFlights = Object.entries(prevState).some(([k, v]) => k.startsWith(date + '|') && k !== missKey);
      newState[missKey] = { count: prevMisses + 1 };

      // After 5 consecutive misses, report as truly gone
      if (hadFlights && prevMisses + 1 >= 5) {
        const prevForDate = Object.entries(prevState).filter(([k]) => k.startsWith(date + '|') && k !== missKey).map(([, v]) => v);
        const prevCheapest = Math.min(...prevForDate.map(f => f.economy).filter(p => p));
        dateChanges[date] = `${dayLabel}: all flights gone (was $${prevCheapest})`;
        // Remove old flight entries from state
        for (const key of Object.keys(newState)) {
          if (key.startsWith(date + '|') && key !== missKey) delete newState[key];
        }
        delete newState[missKey];
      }
      continue;
    }

    // Got results - reset miss counter
    delete newState[missKey];

    // Update state with fresh data for this date
    // First remove old entries for this date
    for (const key of Object.keys(newState)) {
      if (key.startsWith(date + '|')) delete newState[key];
    }
    for (const flight of curFlights) {
      newState[`${date}|${flight.flight}|${flight.from}`] = { ...flight, date, lastSeen: ts };
    }

    // Previous flights for this date
    const prevForDate = Object.entries(prevState)
      .filter(([k]) => k.startsWith(date + '|'))
      .map(([, v]) => v);

    const prevCheapest = prevForDate.length > 0 ? Math.min(...prevForDate.map(f => f.economy).filter(p => p)) : null;
    const curCheapest = Math.min(...curFlights.map(f => f.economy));
    const cheapFlight = curFlights.find(f => f.economy === curCheapest);

    if (prevForDate.length === 0) {
      // Genuinely new date
      const fire = curCheapest < PRICE_THRESHOLD ? ' 🔥' : '';
      dateChanges[date] = `${dayLabel}: ${curFlights.length} new flights, cheapest $${curCheapest} (${cheapFlight.from} ${cheapFlight.dep})${fire}`;
    } else if (curCheapest < prevCheapest) {
      const fire = curCheapest < PRICE_THRESHOLD ? ' 🔥' : '';
      dateChanges[date] = `${dayLabel}: PRICE DROP $${prevCheapest} -> $${curCheapest} (${cheapFlight.from} ${cheapFlight.dep})${fire}`;
    } else if (curCheapest > prevCheapest) {
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
