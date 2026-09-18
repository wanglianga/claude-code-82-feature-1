import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from '../shared/types.js';
import { seed } from './seed.js';

const DATA_FILE = process.env.DATA_FILE || './data/pool-db.json';

function load(): DB {
  try {
    if (existsSync(DATA_FILE)) {
      const data = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as DB;
      if (data && data.users && data.sessions) {
        // 兼容旧版本数据卷：补齐新增的闭池档案集合与场次字段
        if (!Array.isArray(data.closureRecords)) data.closureRecords = [];
        if (!Array.isArray(data.crampRescues)) data.crampRescues = [];
        if (!Array.isArray(data.guardTraining)) data.guardTraining = [];
        if (!Array.isArray(data.institutions)) data.institutions = [];
        if (!Array.isArray(data.rentals)) data.rentals = [];
        if (!Array.isArray(data.institutionBills)) data.institutionBills = [];
        if (!data.facilities) data.facilities = { showerCapacity: 60, lockerCount: 220 };
        for (const s of data.sessions) {
          if (!Array.isArray(s.closureIds)) s.closureIds = [];
          if (!Array.isArray(s.suspendedLanes)) s.suspendedLanes = [];
          if (!Array.isArray(s.guardFocusLanes)) s.guardFocusLanes = [];
          // 兼容版本化前的关注泳道：补齐版本号与历史数组
          for (const f of s.guardFocusLanes) {
            if (typeof f.version !== 'number') f.version = 1;
            if (!Array.isArray(f.history)) f.history = [];
          }
        }
        return data;
      }
    }
  } catch (e) {
    console.error('[store] 数据文件读取失败，重新播种:', (e as Error).message);
  }
  const fresh = seed();
  persist(fresh);
  return fresh;
}

/** 原子写：tmp 文件 + rename，避免并发读到半截 JSON */
function persist(data: DB) {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, DATA_FILE);
}

const db = load();

export function getDB(): DB {
  return db;
}

/** 所有变更必须经过 mutate，落盘后才返回 */
export function mutate<T>(fn: (db: DB) => T): T {
  const result = fn(db);
  persist(db);
  return result;
}

let counter = db.counters?.seq ?? 200;
export function nextId(prefix: string): string {
  counter += 1;
  db.counters.seq = counter;
  return `${prefix}-${counter}`;
}
