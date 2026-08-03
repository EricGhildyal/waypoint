import { SETTING_DEFAULTS } from "./constants";
import { db } from "./db";

export async function getSetting(key: string): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? SETTING_DEFAULTS[key] ?? "";
}

export async function getNumberSetting(key: string): Promise<number> {
  const value = Number(await getSetting(key));
  return Number.isFinite(value) ? value : Number(SETTING_DEFAULTS[key] ?? 0);
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

/** All known settings, defaults merged under stored values. */
export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.setting.findMany();
  const merged: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const row of rows) merged[row.key] = row.value;
  return merged;
}
