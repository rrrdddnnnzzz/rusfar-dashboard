// RUSFAR data proxy — MOEX ISS API (currency engine)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // RUSFAR живёт в engines/currency, НЕ в engines/stock
  const SECS = 'RUSFARON,RUSFARRTON,RUSFAR1W,RUSFAR2W,RUSFAR1M,RUSFAR3M';
  const OPTS = '&iss.meta=off&iss.only=securities,marketdata';

  const URLS = [
    // Основной — currency engine
    `https://iss.moex.com/iss/engines/currency/markets/index/securities.json?securities=${SECS}${OPTS}`,
    // Fallback — stock engine (старый вариант)
    `https://iss.moex.com/iss/engines/stock/markets/index/securities.json?securities=${SECS}${OPTS}`,
    // Статистический endpoint
    `https://iss.moex.com/iss/statistics/engines/currency/markets/index/securities.json?securities=${SECS}${OPTS}`,
  ];

  function parseBlock(json) {
    const md  = json?.marketdata;
    const sec = json?.securities;
    if (!md?.columns || !md?.data?.length) return {};

    const mdCols  = md.columns;
    const secCols = sec?.columns || [];
    const secMap  = {};

    for (const row of (sec?.data || [])) {
      const o = {};
      secCols.forEach((c, i) => o[c] = row[i]);
      secMap[o.SECID] = o;
    }

    const out = {};
    for (const row of md.data) {
      const o = {};
      mdCols.forEach((c, i) => o[c] = row[i]);
      const secid = o.SECID;
      if (!secid) continue;

      // MOEX может возвращать разные поля в зависимости от инструмента.
      // Пробуем все возможные имена полей.
      const value =
        o.LASTVALUE      ?? o.CURRENTVALUE  ?? o.VALUE      ??
        o.SETTLEPRICE    ?? o.MARKETPRICE    ?? null;

      const open =
        o.OPENVALUE      ?? o.OPEN           ?? o.PREVLEGALCLOSEPRICE ?? null;

      if (value == null && open == null) continue;

      const term = secid
        .replace('RUSFARRTON', 'RT')
        .replace('RUSFARON', 'ON')
        .replace('RUSFAR', '');

      out[term] = {
        secid,
        value,
        open,
        updateTime: o.UPDATETIME || o.SYSTIME || null,
        tradeDate:  o.TRADEDATE  || null,
        // 52-недельные min/max берём из securities блока
        annualHigh: secMap[secid]?.ANNUALHIGH ?? secMap[secid]?.HIGH52WEEK ?? null,
        annualLow:  secMap[secid]?.ANNUALLOW  ?? secMap[secid]?.LOW52WEEK  ?? null,
        // для отладки — все поля как есть
        _raw: process.env.NODE_ENV !== 'production' ? o : undefined,
      };
    }
    return out;
  }

  try {
    const responses = await Promise.allSettled(
      URLS.map(url =>
        fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; rusfar-dashboard/1.0)',
            'Accept': 'application/json',
            'Referer': 'https://www.moex.com/',
          },
          signal: AbortSignal.timeout(9000),
        }).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
      )
    );

    // Берём первый успешный результат, у которого есть данные
    let result = {};
    for (const resp of responses) {
      if (resp.status !== 'fulfilled') continue;
      const parsed = parseBlock(resp.value);
      if (Object.keys(parsed).length > 0) {
        result = { ...parsed, ...result }; // ранние (более точные) не перезаписываем
      }
    }

    if (!Object.keys(result).length) {
      // Попробуем получить хотя бы по одному инструменту отдельными запросами
      const singles = await Promise.allSettled(
        ['RUSFARON', 'RUSFARRTON', 'RUSFAR1W', 'RUSFAR2W', 'RUSFAR1M', 'RUSFAR3M'].map(sec =>
          fetch(
            `https://iss.moex.com/iss/engines/currency/markets/index/securities/${sec}.json?iss.meta=off&iss.only=securities,marketdata`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; rusfar-dashboard/1.0)',
                'Accept': 'application/json',
                'Referer': 'https://www.moex.com/',
              },
              signal: AbortSignal.timeout(9000),
            }
          ).then(r => r.json())
        )
      );
      for (const resp of singles) {
        if (resp.status !== 'fulfilled') continue;
        const parsed = parseBlock(resp.value);
        Object.assign(result, parsed);
      }
    }

    if (!Object.keys(result).length) {
      return res.status(502).json({ error: 'MOEX не вернул данных' });
    }

    res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=120');
    return res.status(200).json({ data: result, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
