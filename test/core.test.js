// core.js のテスト:  node test/core.test.js [CSV ファイル]
// CSV を指定しないときは、隣に置いた計測リポジトリ（../insole_v1_measure2_4sensor）の script/data を使い、無ければ合成データを使う。
// main.cpp と同じ手順で v3 / v2 パケットを組み立てて解読し、元の CSV に戻ることを確かめる。
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const C = require("../core.js");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + (e.stack || e).toString().split("\n").slice(0, 3).join("\n     ")); }
}

// ---- main.cpp の encode_inductance / build_packet_v3 / build_packets_v2 と同じ ----
const encode = nh => !Number.isFinite(nh) ? 0xFFFF : Math.max(0, Math.min(0xFFFE, Math.round((nh - 2000) * 10)));
function putSample(buf, pos, s) {
  buf[pos] = s.seq;
  buf[pos + 1] = (s.ts >> 16) & 0xFF; buf[pos + 2] = (s.ts >> 8) & 0xFF; buf[pos + 3] = s.ts & 0xFF;
  s.codes.forEach((c, k) => { buf[pos + 4 + 2 * k] = c >> 8; buf[pos + 5 + 2 * k] = c & 0xFF; });
}
function packetV3(cur, prev, flags) {
  const b = new Uint8Array(74);
  b[0] = 0xB1; b[1] = flags;
  putSample(b, 2, cur); putSample(b, 38, prev);
  return b;
}
function packetsV2(s, flags) {
  const p1 = new Uint8Array(20), p2 = new Uint8Array(20);
  p1[0] = 0xA1; p2[0] = 0xA2; p1[1] = p2[1] = s.seq;
  s.codes.forEach((c, k) => {
    const [p, o] = k < 9 ? [p1, 2 + 2 * k] : [p2, 2 + 2 * (k - 9)];
    p[o] = c >> 8; p[o + 1] = c & 0xFF;
  });
  p2[16] = flags;
  p2[17] = (s.ts >> 16) & 0xFF; p2[18] = (s.ts >> 8) & 0xFF; p2[19] = s.ts & 0xFF;
  return [p1, p2];
}
// 本体側のサンプル列（seq は 1 から、時刻は millis）
const deviceSamples = rows => rows.map((r, i) => ({ seq: (i + 1) & 0xFF, ts: r[0], codes: r.slice(1).map(encode) }));

// ---- テストデータ ----
const csvPath = process.argv[2] || path.join(__dirname, "../../insole_v1_measure2_4sensor/script/data/data_left_K1_walk1_insole_L_7780_20261112_175757.csv");
let csvText;
if (fs.existsSync(csvPath)) {
  csvText = fs.readFileSync(csvPath, "utf8");
  console.log("data: " + path.basename(csvPath));
} else {
  // データが無い環境用の合成データ
  const lines = [];
  for (let i = 0; i < 500; i++) {
    const vals = Array.from({ length: 16 }, (_, k) => (4000 + 50 * Math.sin(i / 10 + k) + k).toFixed(1));
    if (i === 100) vals[3] = "nan";
    lines.push([828435 + 25 * i, ...vals].join(","));
  }
  csvText = lines.join("\n") + "\n";
  console.log("data: synthetic");
}
const rows = C.parseCsv(csvText);
const dev = deviceSamples(rows);
const LEFT_FLAGS = 0x00;

test("parseCsv で全行読める", () => {
  assert.strictEqual(rows.length, csvText.trim().split(/\r?\n/).length);
  assert.strictEqual(rows[0].length, 17);
});

test("rowsToCsv で元の CSV と同じ文字列に戻る", () => {
  assert.strictEqual(C.rowsToCsv(rows), csvText.replace(/\r\n/g, "\n"));
});

function receive(packets) {
  const d = C.createDecoder(), out = [];
  for (const p of packets) for (const s of C.handlePacket(d, p)) out.push([s.ts, ...s.values]);
  return { d, out };
}

test("v3: 全部届けば元の CSV に戻る", () => {
  const pk = dev.map((s, i) => packetV3(s, dev[Math.max(0, i - 1)], LEFT_FLAGS));
  const { d, out } = receive(pk);
  assert.strictEqual(d.format, "v3");
  assert.strictEqual(C.rowsToCsv(out), C.rowsToCsv(rows));
  assert.deepStrictEqual([d.missing, d.recovered, d.dup], [0, 0, 0]);
});

test("v3: 1回ずつの取りこぼしは「1つ前」で補われる", () => {
  const pk = dev.map((s, i) => packetV3(s, dev[Math.max(0, i - 1)], LEFT_FLAGS)).filter((_, i) => i % 7 !== 3);
  const { d, out } = receive(pk);
  assert.strictEqual(C.rowsToCsv(out), C.rowsToCsv(rows));
  assert.strictEqual(d.missing, 0);
  assert.ok(d.recovered > 0);
});

test("v3: 2回続けて落ちたときだけ1サンプル欠ける", () => {
  const drop = new Set([50, 51]);
  const pk = dev.map((s, i) => packetV3(s, dev[Math.max(0, i - 1)], LEFT_FLAGS)).filter((_, i) => !drop.has(i));
  const { d, out } = receive(pk);
  assert.strictEqual(out.length, rows.length - 1);
  assert.strictEqual(d.missing, 1);
  assert.ok(!out.some(r => r[0] === rows[50][0]));
});

test("v3: 同じ通知を2回受けても二重に保存しない", () => {
  const pk = [];
  dev.slice(0, 100).forEach((s, i) => { const p = packetV3(s, dev[Math.max(0, i - 1)], LEFT_FLAGS); pk.push(p, p); });
  const { d, out } = receive(pk);
  assert.strictEqual(out.length, 100);
  assert.strictEqual(d.dup, 100);
});

test("v2: 2便を組にして元の CSV に戻る", () => {
  const pk = dev.flatMap(s => packetsV2(s, LEFT_FLAGS));
  const { d, out } = receive(pk);
  assert.strictEqual(d.format, "v2");
  assert.strictEqual(C.rowsToCsv(out), C.rowsToCsv(rows));
});

test("v2: 片方の便が落ちたサンプルは捨てて、欠けとして数える", () => {
  const pk = dev.flatMap((s, i) => { const [a, b] = packetsV2(s, LEFT_FLAGS); return i === 20 ? [a] : i === 40 ? [b] : [a, b]; });
  const { d, out } = receive(pk);
  assert.strictEqual(out.length, rows.length - 2);
  assert.strictEqual(d.missing, 2);
  assert.ok(d.mismatch >= 1);
});

test("再接続（resetLink）しても受信済みのサンプルは保存しない", () => {
  const d = C.createDecoder(), out = [];
  const pk = dev.slice(0, 60).map((s, i) => packetV3(s, dev[Math.max(0, i - 1)], LEFT_FLAGS));
  pk.slice(0, 40).forEach(p => C.handlePacket(d, p).forEach(s => out.push(s.ts)));
  C.resetLink(d);
  pk.slice(30, 60).forEach(p => C.handlePacket(d, p).forEach(s => out.push(s.ts)));
  assert.strictEqual(out.length, 60);
  assert.strictEqual(new Set(out).size, 60);
});

test("24bit 時刻の繰り上がりで timestamp が連続する", () => {
  const base = 0xFFFF00;
  const s = Array.from({ length: 30 }, (_, i) => ({ seq: i, ts: base + 25 * i, codes: new Array(16).fill(20000) }));
  const wire = s.map(x => ({ ...x, ts: x.ts & 0xFFFFFF }));
  const { out } = receive(wire.map((x, i) => packetV3(x, wire[Math.max(0, i - 1)], 0)));
  assert.deepStrictEqual(out.map(r => r[0]), s.map(x => x.ts));
});

test("本体の再起動（時刻が大きく戻る）を受け付ける", () => {
  const a = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, ts: 900000 + 25 * i, codes: new Array(16).fill(1) }));
  const b = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, ts: 3000 + 25 * i, codes: new Array(16).fill(2) }));
  const pk = [...a.map((x, i) => packetV3(x, a[Math.max(0, i - 1)], 0)), ...b.map((x, i) => packetV3(x, b[Math.max(0, i - 1)], 0))];
  const { d, out } = receive(pk);
  assert.strictEqual(out.length, 20);
  assert.strictEqual(d.rebooted, 1);
});

test("センサーエラー (0xFFFF) は nan、範囲外は端に張り付く", () => {
  const s = { seq: 1, ts: 1000, codes: [0xFFFF, 0, 0xFFFE, ...new Array(13).fill(12345)] };
  const { out } = receive([packetV3(s, s, 0x03)]);
  assert.ok(Number.isNaN(out[0][1]));
  assert.strictEqual(out[0][2], 2000);
  assert.strictEqual(out[0][3], 8553.4);
  assert.strictEqual(C.rowToCsv(out[0]).split(",")[1], "nan");
});

test("旧ファーム（0x00 / 0x11）は受け付けず数える", () => {
  const p = new Uint8Array(20); p[0] = 0x00;
  const q = new Uint8Array(20); q[0] = 0x11;
  const { d, out } = receive([p, q]);
  assert.strictEqual(out.length, 0);
  assert.strictEqual(d.legacy, 2);
});

test("computeForces が foot_view.py の式と一致する", () => {
  // foot_view.py の FX_TERMS / FY_TERMS / LEFT_SIGN を手で展開した値
  const d = Array.from({ length: 16 }, (_, k) => (k * 37) % 11 - 5 + k / 10);
  const ch = (s, c) => d[(s - 1) * 4 + c - 1];
  const fxR = [ch(1,4)+ch(1,3)-ch(1,1)-ch(1,2), ch(2,2)+ch(2,3)-ch(2,1)-ch(2,4), ch(3,4)+ch(3,1)-ch(3,2)-ch(3,3), ch(4,1)+ch(4,2)-ch(4,4)-ch(4,3)];
  const fyR = [ch(1,2)+ch(1,3)-ch(1,1)-ch(1,4), ch(2,1)+ch(2,2)-ch(2,3)-ch(2,4), ch(3,3)+ch(3,4)-ch(3,1)-ch(3,2), ch(4,1)+ch(4,4)-ch(4,2)-ch(4,3)];
  const fz = [1,2,3,4].map(s => ch(s,1)+ch(s,2)+ch(s,3)+ch(s,4));
  const R = C.computeForces(d, "R"), L = C.computeForces(d, "L");
  const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${v} != ${b[i]}`));
  close(R.fx, fxR); close(R.fy, fyR); close(R.fz, fz); close(L.fz, fz);
  close(L.fx, fxR.map((v, i) => v * [-1, 1, 1, -1][i]));
  close(L.fy, fyR.map((v, i) => v * [1, -1, -1, 1][i]));
});

test("forceSeries: 長さがそろい、最初の1秒の平均がほぼ 0", () => {
  const F = C.forceSeries(rows, "L");
  assert.strictEqual(F.time.length, rows.length);
  for (const d of ["x", "y", "z"]) {
    assert.strictEqual(F[d].length, 4);
    for (let s = 0; s < 4; s++) {
      assert.ok(F[d][s].every(Number.isFinite));
      const m = F[d][s].slice(0, 40).reduce((a, b) => a + b, 0) / 40;
      assert.ok(Math.abs(m) < 1e-6, `${d}${s} mean ${m}`);
    }
  }
});

console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
