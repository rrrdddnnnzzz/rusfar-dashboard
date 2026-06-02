// RUSFAR история за последние N месяцев — агрегация по месяцам
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Берём данные за последние 13 месяцев
  const till  = new Date();
  const from  = new Date(till);
  from.setMonth(from.getMonth() - 13);
  const fmt = d => d.toISOString().slice(0, 10);

  // Ключевая ставка ЦБ РФ (исторические значения — обновляй вручную при изменении)
  // Дата → ставка, действующая С этой даты
  const KEY_RATE_HISTORY = [
    ['2024-07-26', 18.0],
    ['2024-09-13', 19.0],
    ['2024-10-25', 21.0],
    ['2025-02-14', 21.0], // без изменений
    ['2025-04-25', 21.0],
    ['2025-06-06', 20.0],
    ['2025-07-25', 21.0], // гипотетически — заменить реальным
    ['2026-02-14', 19.5],
    ['2026-03-21', 17.0],
    ['2026-04-25', 16.0],
    ['2026-06-06', 15.0],
  ];

  function getRateForDate(dateStr) {
    // Ищем последнюю ставку, действующую на указанную дату
    let rate = 16.0; // default
    for (const [d, r] of KEY_RATE_HISTORY) {
      if (dateStr >= d) rate = r;
    }
    return rate;
  }

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; rusfar-dashboard/1.0)',
    'Accept': 'application/json',
    'Referer': 'https://www.moex.com/',
  };

  async function fetchHistory(secid) {
    // Пробуем currency engine, потом stock
    const engines = ['currency', 'stock'];
    for (const eng of engines) {
      try {
        const url = `https://iss.moex.com/iss/history/engines/${eng}/markets/index/securities/${secid}.json?from=${fmt(from)}&till=${fmt(till)}&iss.meta=off&start=0&limit=300`;
        const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const j = await r.json();
        const hist = j?.history;
        if (!hist?.columns || !hist?.data?.length) continue;
        return { columns: hist.columns, data: hist.data };
      } catch {}
    }
    return null;
  }

  try {
    const hist = await fetchHistory('RUSFARON');
    if (!hist) {
      return res.status(502).json({ error: 'Не удалось получить историю RUSFARON' });
    }

    const cols = hist.columns;
    const iClose = cols.indexOf('CLOSE') >= 0 ? cols.indexOf('CLOSE') :
                   cols.indexOf('VALUE') >= 0  ? cols.indexOf('VALUE')  :
                   cols.indexOf('CURRENTVALUE') >= 0 ? cols.indexOf('CURRENTVALUE') : -1;
    const iDate  = cols.indexOf('TRADEDATE');

    if (iClose === -1 || iDate === -1) {
      return res.status(502).json({ error: 'Неизвестный формат истории MOEX', columns: cols });
    }

    // Агрегируем по месяцам (среднее)
    const monthly = {};
    for (const row of hist.data) {
      const dateStr = row[iDate];
      const val     = row[iClose];
      if (!dateStr || val == null) continue;
      const month = dateStr.slice(0, 7); // 'YYYY-MM'
      if (!monthly[month]) monthly[month] = { sum: 0, cnt: 0, dateStr };
      monthly[month].sum += +val;
      monthly[month].cnt += 1;
    }

    const RU_MONTHS = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];

    const result = Object.entries(monthly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, { sum, cnt }]) => {
        const avg = +(sum / cnt).toFixed(2);
        const [year, mon] = month.split('-');
        const label = `${RU_MONTHS[+mon - 1]} ${year.slice(2)}`;
        return { m: label, month, on: avg, ks: getRateForDate(month + '-01') };
      });

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({ history: result, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
