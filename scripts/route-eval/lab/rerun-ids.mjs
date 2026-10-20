// 按 id 子集重跑 dev 样本（只用于补日志/诊断，不用于留出集）。
// 用法：node scripts/route-eval/lab/rerun-ids.mjs --router <module> --ids <file 每行一个 id> --out <results.jsonl> [--concurrency 4]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSamples, V2_DIR } from './data.mjs';
import { loadSessions, evaluate, rowForDisk } from '../runner.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ids = new Set(fs.readFileSync(arg('--ids'), 'utf8').split('\n').filter(Boolean));
const samples = loadSamples('dev').filter((s) => ids.has(s.id));
const mod = await import(pathToFileURL(path.resolve(arg('--router'))).href);
const sessions = loadSessions(JSON.parse(fs.readFileSync(path.join(V2_DIR, 'sessions.json'), 'utf8')));
const out = arg('--out');
fs.writeFileSync(out, '');
const r = await evaluate({ router: await mod.create(), samples, sessions, concurrency: Number(arg('--concurrency', 4)), maxCostUsd: 15, retries: 2, onRow: (row) => fs.appendFileSync(out, JSON.stringify(rowForDisk(row)) + '\n') });
console.log(JSON.stringify({ ran: r.rows.length, spentUsd: r.spentUsd }));
