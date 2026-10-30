// Minimal Qt-style INI reader/writer (Prism's instance.cfg / prismlauncher.cfg).
// Prism writes plain [Section] + key=value files; values may contain escaped
// sequences (\n, \\, etc.) only rarely in the keys we touch, so we keep the
// parser deliberately small and preserve unknown lines verbatim per section.

export type IniData = Map<string, Map<string, string>>;

export function parseIni(text: string): IniData {
  const data: IniData = new Map();
  let section = "";
  if (!data.has(section)) data.set(section, new Map());
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.*)\]$/);
    if (sec) {
      section = sec[1];
      if (!data.has(section)) data.set(section, new Map());
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    data.get(section)!.set(key, value);
  }
  return data;
}

export function stringifyIni(data: IniData): string {
  const out: string[] = [];
  for (const [section, entries] of data) {
    if (section) out.push(`[${section}]`);
    for (const [k, v] of entries) out.push(`${k}=${v}`);
    out.push("");
  }
  return out.join("\n");
}

export function iniGet(data: IniData, section: string, key: string): string | undefined {
  return data.get(section)?.get(key);
}

export function iniSet(data: IniData, section: string, key: string, value: string): void {
  if (!data.has(section)) data.set(section, new Map());
  data.get(section)!.set(key, value);
}
