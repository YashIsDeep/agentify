import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";

export class SettingsStore {
  constructor(private readonly db: Db) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.select().from(s.settings).where(eq(s.settings.key, key)).get();
    return row ? (row.value as T) : fallback;
  }

  set(key: string, value: unknown): void {
    const updatedAt = Date.now();
    this.db
      .insert(s.settings)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: s.settings.key, set: { value, updatedAt } })
      .run();
  }
}
