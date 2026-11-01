import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketKey, bucketOf, endOf, parseTime, startOf, wallParts, zonedEpoch,
} from '../src/time.mjs';

const SH = 'Asia/Shanghai';

test('上海时区：日边界按本地日历，而不是 UTC', () => {
  const ts = Date.parse('2026-11-01T13:29:55+08:00');
  const start = startOf(ts, 'day', SH);
  assert.equal(start, Date.parse('2026-11-01T00:00:00+08:00'));
  assert.equal(endOf(start, 'day', SH), Date.parse('2026-11-02T00:00:00+08:00'));
  assert.equal(bucketKey(start, 'day', SH), '2026-11-01');
});

test('周桶从周一开始', () => {
  const ts = Date.parse('2026-11-01T13:00:00+08:00'); // 周日
  const start = startOf(ts, 'week', SH);
  assert.equal(wallParts(start, SH).weekday, 1);
  assert.ok(start <= ts);
  assert.equal(endOf(start, 'week', SH) - start, 7 * 86400000);
  assert.equal(bucketKey(start, 'week', SH), '2026-W44');
});

test('月桶与年桶', () => {
  const ts = Date.parse('2026-11-01T13:00:00+08:00');
  assert.equal(startOf(ts, 'month', SH), Date.parse('2026-11-01T00:00:00+08:00'));
  assert.equal(bucketKey(ts, 'month', SH), '2026-11');
  assert.equal(startOf(ts, 'year', SH), Date.parse('2026-01-01T00:00:00+08:00'));
  assert.equal(bucketKey(ts, 'year', SH), '2026');
});

test('夏令时：纽约 3 月 8 日的日边界是 EST 零点', () => {
  const ts = Date.parse('2026-03-08T12:00:00-04:00');
  assert.equal(startOf(ts, 'day', 'America/New_York'), Date.parse('2026-03-08T00:00:00-05:00'));
});

test('parseTime 支持日期、日期时间与时间戳', () => {
  assert.equal(parseTime('2026-11-01', SH), Date.parse('2026-11-01T00:00:00+08:00'));
  assert.equal(parseTime('2026-11-01 08:30', SH), Date.parse('2026-11-01T08:30:00+08:00'));
  assert.equal(parseTime(1762000000000, SH), 1762000000000);
  assert.equal(parseTime('', SH), null);
});

test('zonedEpoch 与 wallParts 互为逆运算', () => {
  const ts = zonedEpoch(2026, 11, 1, 13, 29, 0, SH);
  const p = wallParts(ts, SH);
  assert.deepEqual(
    { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute },
    { y: 2026, m: 11, d: 1, h: 13, min: 29 },
  );
});

test('bucketOf 给出左闭右开区间', () => {
  const ts = Date.parse('2026-11-01T23:59:59+08:00');
  const b = bucketOf(ts, 'day', SH);
  assert.ok(ts >= b.start && ts < b.end);
  assert.equal(b.key, '2026-11-01');
});
