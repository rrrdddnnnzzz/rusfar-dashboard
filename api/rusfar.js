// RUSFAR data proxy — устойчив к разным форматам ответа MOEX
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const BASE = 'https://iss.moex.com/iss/engines/stock/markets/index/securities.json';
  const OPTS = '&iss.meta=off&iss.only=securities,marketdata';

  // Запрашиваем ВСЕ инструменты одним списком + отдельно ON/RT на случай если они в другой выдаче
  const URLS = [
    `${BASE}?securities=RUSFARON,RUSFARRTON,RUSFAR1W,RUSFAR2W,RUSFAR1M,RUSFAR3M${OPTS}`,
    `${BASE}?securities=RUSFARON${OPTS}`,
    `${BASE}?securities=RUSFARRTON${OPTS}`,
  ];

  function parseBlock(json) {
    const md = json?.marketdata;
    const sec = json?.securities;
    if (!md?.columns || !md?.data?.length) return {};
    const mdCols = md.columns;
    const secCols = sec?.columns || [];
    const secMap = {};
    for (const row of (sec?.data || [])) {
      const o = {}; secCols.forEach((c,i)=>o[c]=row[i]); secMap[o.SECID]=o;
    }
    const out = {};
    for (const row of md.data) {
      const o = {}; mdCols.forEach((c,i)=>o[c]=row[i]);
      const secid = o.SECID;
      if (!secid) continue;
      // Пропускаем строки без данных
      if (o.LASTVALUE == null && o.CURRENTVALUE == null) continue;
      const term = secid.replace('RUSFARRTON','RT').replace('RUSFARON','ON').replace('RUSFAR','');
      out[term] = {
        secid,
        value:        o.LASTVALUE,
        currentValue: o.CURRENTVALUE,
        open:         o.OPENVALUE,
        updateTime:   o.UPDATETIME,
        tradeDate:    o.TRADEDATE,
        annualHigh:   secMap[secid]?.ANNUALHIGH,
        annualLow:    secMap[secid]?.ANNUALLOW,
      };
    }
    return out;
  }

  try {
    const responses = await Promise.allSettled(
      URLS.map(url => fetch(url, {
        headers: { 'User-Agent':'Mozilla/5.0', 'Accept':'application/json' },
        signal: AbortSignal.timeout(9000),
      }).then(r => r.json()))
    );

    const blocks = responses
      .filter(r => r.status === 'fulfilled')
      .map(r => parseBlock(r.value));

    const result = Object.assign({}, ...blocks);

    if (!Object.keys(result).length) {
      return res.status(502).json({ error: 'MOEX не вернул данных' });
    }

    res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate');
    return res.status(200).json({ data: result, fetchedAt: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
