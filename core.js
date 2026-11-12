// core.js  画面に依存しない処理（BLE パケットの解読・CSV・力の計算）
// index.html から読み込むほか、Node でもテストできるようにしている（test/core.test.js）。
//
// 対応するファームウェア: insole_v1_measure2_4sensor リポジトリの src/main.cpp（4センサー × 4コイル、25 ms = 40 Hz）
// 受信処理は同じリポジトリの script/insole_live_collect_plot.py、力の式は script/foot_view.py と同じ。
(function (root) {
  "use strict";

  const SENS = 4, COILS = 4, NCH = SENS * COILS;
  const FS = 40;                       // サンプリング周波数 [Hz]

  // ---- BLE パケット（main.cpp の build_packet_v3 / build_packets_v2） ----
  const V3_HEADER = 0xB1, V3_SAMPLE = 1 + 3 + 2 * NCH, V3_SIZE = 2 + 2 * V3_SAMPLE; // 36, 74
  const V2_HEADER1 = 0xA1, V2_HEADER2 = 0xA2, V2_SIZE = 20, V2_COILS_IN_P1 = 9;
  const LEGACY_HEADER1 = 0x00, LEGACY_HEADER2 = 0x11;
  const L_OFFSET_NH = 2000, L_SCALE = 10, L_CODE_ERROR = 0xFFFF;
  const FLAG_LDC_ERR = 0x01, FLAG_SIDE_RIGHT = 0x02;
  const REBOOT_BACKSTEP_MS = 5000;     // 時刻がこれ以上戻ったら本体の再起動とみなす

  // コイル値 = round((L[nH] - 2000) * 10)。0xFFFF はセンサーエラー
  const codeToNh = c => c === L_CODE_ERROR ? NaN : L_OFFSET_NH + c / L_SCALE;

  // 1台ぶんの受信状態。再接続しても同じものを使い続ける（受信済みサンプルを二重に保存しないため）
  function createDecoder() {
    return {
      format: "",        // "v3" / "v2"（受信したパケットで決まる）
      packet1: null,     // v2 の1便目
      lastSeq: null, tsPrev24: null, tsWrap: 0, lastTs: null,
      missing: 0,        // 補えずに欠けたサンプル数（seq の飛び）
      recovered: 0,      // v3: 通知を取りこぼしたが「1つ前」で補えた数
      dup: 0,            // 受信済みのサンプル（保存しない）
      mismatch: 0,       // v2: 1便目と2便目の seq が違った
      legacy: 0,         // 旧ファーム（5センサー版など）のパケット。受け付けない
      rebooted: 0,
    };
  }

  // 再接続のたびに呼ぶ。切断中の seq の飛びを取りこぼしとして数えない（時刻は保持して重複保存を防ぐ）
  function resetLink(d) { d.packet1 = null; d.lastSeq = null; }

  // 新しいサンプルなら連続した timestamp_ms を返す。受信済みなら null（insole_live_collect_plot.py の _accept）
  function accept(d, seq, ts24, countDup = true) {
    let wrap = d.tsWrap;
    if (d.tsPrev24 !== null && ts24 < d.tsPrev24 && d.tsPrev24 - ts24 > 0x800000) wrap += 0x1000000;
    let ts = wrap + ts24;
    if (d.lastTs !== null && ts <= d.lastTs) {
      if (d.lastTs - ts <= REBOOT_BACKSTEP_MS) { if (countDup) d.dup++; return null; }
      // 時刻が大きく戻った = 本体が再起動した。ここから数え直す
      d.rebooted++;
      d.lastSeq = null;
    }
    if (d.lastSeq !== null) {
      const step = (seq - d.lastSeq) & 0xFF;
      d.missing += (step || 256) - 1;
    }
    d.lastSeq = seq; d.tsWrap = wrap; d.tsPrev24 = ts24; d.lastTs = ts;
    return ts;
  }

  const u16 = (b, i) => (b[i] << 8) | b[i + 1];
  const u24 = (b, i) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];

  // 受信した1回分の通知 (Uint8Array) を処理し、新しいサンプルの配列を返す。
  // サンプル = { ts, flags, seq, values: Float64Array(16) [nH] }
  function handlePacket(d, b) {
    if (!b || !b.length) return [];
    const h = b[0];
    if (h === V3_HEADER && b.length >= V3_SIZE) {
      d.format = "v3";
      const flags = b[1], out = [];
      const curSeq = b[2], prevPos = 2 + V3_SAMPLE;
      // 1つ前のサンプルを先に処理する。前の通知を取りこぼしていればここで補われる
      for (const [pos, isPrev] of [[prevPos, true], [2, false]]) {
        const seq = b[pos];
        if (isPrev && seq === curSeq) continue;   // 起動直後の最初のサンプルは「1つ前」も同じもの
        const hadPrevious = d.lastSeq !== null;
        const ts = accept(d, seq, u24(b, pos + 1), !isPrev);
        if (ts === null) continue;
        if (isPrev && hadPrevious) d.recovered++;
        const values = new Float64Array(NCH);
        for (let k = 0; k < NCH; k++) values[k] = codeToNh(u16(b, pos + 4 + 2 * k));
        out.push({ ts, flags, seq, values });
      }
      return out;
    }
    if (b.length !== V2_SIZE) return [];
    if (h === V2_HEADER1) { d.packet1 = b; return []; }
    if (h === V2_HEADER2) {
      const p1 = d.packet1;
      if (!p1 || p1[1] !== b[1]) { d.mismatch++; return []; }
      d.packet1 = null;
      d.format = "v2";
      const seq = b[1];
      const ts = accept(d, seq, u24(b, 17));
      if (ts === null) return [];
      const values = new Float64Array(NCH);
      for (let k = 0; k < NCH; k++) {
        values[k] = codeToNh(k < V2_COILS_IN_P1 ? u16(p1, 2 + 2 * k) : u16(b, 2 + 2 * (k - V2_COILS_IN_P1)));
      }
      return [{ ts, flags: b[16], seq, values }];
    }
    if (h === LEGACY_HEADER1 || h === LEGACY_HEADER2) d.legacy++;
    return [];
  }

  // ---- CSV（ヘッダーなし、17列: timestamp_ms, s1c1..s4c4。値は nH で小数1桁、エラーは nan） ----
  const fmtNh = v => Number.isFinite(v) ? v.toFixed(1) : "nan";
  function rowToCsv(r) {   // r = [ts, v0..v15]
    let s = String(r[0]);
    for (let k = 1; k <= NCH; k++) s += "," + fmtNh(r[k]);
    return s;
  }
  const rowsToCsv = rows => rows.map(rowToCsv).join("\n") + "\n";

  // 保存済み CSV を読む。ヘッダー行があっても飛ばす。旧ファームの整数値もそのまま読める
  function parseCsv(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const cols = line.trim().split(",");
      if (cols.length < NCH + 1) continue;
      const ts = Number(cols[0]);
      if (!Number.isFinite(ts)) continue;
      const r = [ts];
      for (let k = 1; k <= NCH; k++) {
        const c = cols[k].trim().toLowerCase();
        r.push(c === "nan" || c === "" ? NaN : Number(c));
      }
      rows.push(r);
    }
    return rows;
  }

  // ---- 力の計算（foot_view.py と同じ式。単位はキャリブレーション前のインダクタンス変化 nH） ----
  // 右足基準。ch は 1 始まり。[足す ch, 引く ch]
  const FX_TERMS = { 1: [[4, 3], [1, 2]], 2: [[2, 3], [1, 4]], 3: [[4, 1], [2, 3]], 4: [[1, 2], [4, 3]] };
  const FY_TERMS = { 1: [[2, 3], [1, 4]], 2: [[1, 2], [3, 4]], 3: [[3, 4], [1, 2]], 4: [[1, 4], [2, 3]] };
  // 左足で掛ける符号 [Fx, Fy]
  const LEFT_SIGN = { 1: [-1, +1], 2: [+1, -1], 3: [+1, -1], 4: [-1, +1] };

  // delta: 長さ16（センサー s のコイル c は s*4+c）。side: "L" / "R"。
  // 戻り値 fx（体の内側が正）、fy（前が正）、fz（4コイルの合計）。各 長さ4
  function computeForces(delta, side) {
    const fx = new Float64Array(SENS), fy = new Float64Array(SENS), fz = new Float64Array(SENS);
    for (let s = 1; s <= SENS; s++) {
      const o = (s - 1) * COILS, ch = c => delta[o + c - 1];
      const combo = ([plus, minus]) => plus.reduce((a, c) => a + ch(c), 0) - minus.reduce((a, c) => a + ch(c), 0);
      const [sx, sy] = side === "L" ? LEFT_SIGN[s] : [1, 1];
      fx[s - 1] = sx * combo(FX_TERMS[s]);
      fy[s - 1] = sy * combo(FY_TERMS[s]);
      fz[s - 1] = ch(1) + ch(2) + ch(3) + ch(4);
    }
    return { fx, fy, fz };
  }

  // ---- ローパスフィルタ（5センサー版アプリの force_data_processor.py と同じ係数。40 Hz 用、filtfilt） ----
  const LP_B = [0.34682180784693817, 1.3872872313877527, 2.0809308470816292, 1.3872872313877527, 0.34682180784693817];
  const LP_A = [1.0, 1.9684277869385178, 1.735860709208886, 0.7244708295073624, 0.12038959989624445];
  const LP_ZI = [0.6531781921530618, 1.234318747703827, 0.889248609831084, 0.22643220795069374];
  function lfilter(x, zi0) {
    const n = x.length, y = new Float64Array(n), z = zi0.slice();
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = LP_B[0] * xi + z[0];
      for (let k = 0; k < 3; k++) z[k] = LP_B[k + 1] * xi + z[k + 1] - LP_A[k + 1] * yi;
      z[3] = LP_B[4] * xi - LP_A[4] * yi;
      y[i] = yi;
    }
    return y;
  }
  function filtfilt(x) {
    const n = x.length, pad = 15;
    if (n <= pad) return Float64Array.from(x);
    const ext = new Float64Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
    for (let i = 0; i < n; i++) ext[pad + i] = x[i];
    for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];
    let y = lfilter(ext, LP_ZI.map(v => v * ext[0]));
    y.reverse();
    y = lfilter(y, LP_ZI.map(v => v * y[0]));
    y.reverse();
    return y.slice(pad, pad + n);
  }

  // nan を直前の値（先頭なら最初の有効値）で埋める。全部 nan なら 0
  function fillNan(a) {
    const out = Float64Array.from(a);
    let first = out.findIndex(Number.isFinite);
    if (first < 0) return out.fill(0);
    for (let i = 0; i < first; i++) out[i] = out[first];
    for (let i = first + 1; i < out.length; i++) if (!Number.isFinite(out[i])) out[i] = out[i - 1];
    return out;
  }

  // 記録全体の力の時系列。ゼロ点は最初の zeroSeconds 秒の平均（foot_view.py と同じ）。
  // loadSign: +1 = ΔL をそのまま使う（foot_view.py と同じ）、-1 = 符号を反転する
  function forceSeries(rows, side, { zeroSeconds = 1, loadSign = 1, filter = true } = {}) {
    const n = rows.length;
    // 時刻は本体の timestamp_ms の差を積み上げる。本体の再起動などで時刻が戻ったり飛んだりしたところは 25 ms とみなす
    const time = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const dt = rows[i][0] - rows[i - 1][0];
      time[i] = time[i - 1] + (dt > 0 && dt <= REBOOT_BACKSTEP_MS ? dt : 1000 / FS) / 1000;
    }
    const ch = [];
    for (let k = 0; k < NCH; k++) {
      const raw = fillNan(Float64Array.from(rows, r => r[k + 1]));
      ch.push(filter ? filtfilt(raw) : raw);
    }
    const nz = Math.max(1, Math.min(n, Math.round(zeroSeconds * FS)));
    const base = ch.map(a => { let s = 0; for (let i = 0; i < nz; i++) s += a[i]; return s / nz; });
    const F = { time, x: [], y: [], z: [] };
    for (let s = 0; s < SENS; s++) { F.x.push(new Float64Array(n)); F.y.push(new Float64Array(n)); F.z.push(new Float64Array(n)); }
    const delta = new Float64Array(NCH);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < NCH; k++) delta[k] = loadSign * (ch[k][i] - base[k]);
      const { fx, fy, fz } = computeForces(delta, side);
      for (let s = 0; s < SENS; s++) { F.x[s][i] = fx[s]; F.y[s][i] = fy[s]; F.z[s][i] = fz[s]; }
    }
    for (const d of ["x", "y", "z"]) {
      const sum = new Float64Array(n);
      for (let i = 0; i < n; i++) for (let s = 0; s < SENS; s++) sum[i] += F[d][s][i];
      F[d + "Sum"] = sum;
    }
    return F;
  }

  const api = {
    SENS, COILS, NCH, FS, FLAG_LDC_ERR, FLAG_SIDE_RIGHT,
    V3_HEADER, V3_SAMPLE, V3_SIZE, V2_HEADER1, V2_HEADER2, V2_SIZE, V2_COILS_IN_P1,
    codeToNh, createDecoder, resetLink, handlePacket,
    rowToCsv, rowsToCsv, parseCsv,
    FX_TERMS, FY_TERMS, LEFT_SIGN, computeForces, filtfilt, fillNan, forceSeries,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InsoleCore = api;
})(typeof self !== "undefined" ? self : this);
