const SGT_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function todaySgt(now: Date = new Date()): string {
  return SGT_DATE.format(now);
}

export function monthToDate(ym: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error(`Invalid month: ${ym}`);
  return `${ym}-01`;
}

export function addMonths(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

export function uraMmyyToDate(mmyy: string): string {
  if (!/^(0[1-9]|1[0-2])\d{2}$/.test(mmyy)) throw new Error(`Invalid URA MMYY: ${mmyy}`);
  return `20${mmyy.slice(2)}-${mmyy.slice(0, 2)}-01`;
}

export function uraQuarter(date: string): string {
  return `${date.slice(2, 4)}q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

export function previousUraQuarter(q: string): string {
  const m = /^(\d{2})q([1-4])$/.exec(q);
  if (!m) throw new Error(`Invalid URA quarter: ${q}`);
  let year = Number(m[1]);
  let quarter = Number(m[2]) - 1;
  if (quarter === 0) { quarter = 4; year -= 1; }
  return `${String(year).padStart(2, '0')}q${quarter}`;
}

/** Newest first: [current, previous, ...]. */
export function uraQuartersBack(date: string, count: number): string[] {
  const out = [uraQuarter(date)];
  while (out.length < count) out.push(previousUraQuarter(out[out.length - 1]));
  return out;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
