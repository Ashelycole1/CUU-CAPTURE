/**
 * ISO 3166-1 alpha-2 codes with display names (via Intl.DisplayNames when
 * available) and flag emoji built from regional-indicator symbols. Pure.
 */
const CODES =
  'AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM UY UZ VU VE VN VG VI WF EH YE ZM ZW XK'.split(
    ' ',
  );

/** 'KE' → 🇰🇪 (regional indicator A = U+1F1E6). */
export function flagEmoji(code: string): string {
  const c = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65, 0x1f1e6 + c.charCodeAt(1) - 65);
}

export interface Country {
  code: string;
  name: string;
  flag: string;
}

let cache: Country[] | null = null;

export function countryName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code.toUpperCase();
  }
}

export function countries(locale = 'en'): Country[] {
  if (cache) return cache;
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    names = null;
  }
  cache = CODES.map((code) => ({ code, name: names?.of(code) ?? code, flag: flagEmoji(code) })).sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

/** East African neighbours first: the most common nationalities at Cavendish. */
export const COMMON_COUNTRIES = ['KE', 'TZ', 'RW', 'BI', 'SS', 'CD', 'SO', 'NG', 'ET', 'ER', 'SD'];

/** Case/diacritic-insensitive search by name or code; prefix matches rank first. */
export function searchCountries(list: Country[], q: string): Country[] {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const query = norm(q.trim());
  if (!query) {
    const common = COMMON_COUNTRIES.map((c) => list.find((x) => x.code === c)).filter((x): x is Country => !!x);
    return [...common, ...list.filter((x) => !COMMON_COUNTRIES.includes(x.code))];
  }
  const scored: { c: Country; s: number }[] = [];
  for (const c of list) {
    const n = norm(c.name);
    if (c.code.toLowerCase() === query) scored.push({ c, s: 0 });
    else if (n.startsWith(query)) scored.push({ c, s: 1 });
    else if (n.split(/[\s,()-]+/).some((w) => w.startsWith(query))) scored.push({ c, s: 2 });
    else if (n.includes(query)) scored.push({ c, s: 3 });
  }
  return scored.sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name)).map((x) => x.c);
}
