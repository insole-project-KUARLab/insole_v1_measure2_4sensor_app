/**
 * インソール計測アプリ（4センサー版）→ Google ドライブの受け口（Google Apps Script）
 *
 * 5センサー版アプリと同じ形式で受け取るので、すでにデプロイ済みの受け口があればそれをそのまま使えます。
 * 新しく作るときだけ、これを script.google.com の新しいプロジェクトに貼り付けてください（手順は README.md）。
 *
 * 保存先: FOLDER_ID のフォルダ / <記録した日付> / <被験者 ID> / csv（または png） / ファイル
 * 同じ名前で中身が同じファイルがあれば何もしない。中身が違えば上書きせずに _2, _3 … を付けて保存する。
 *
 * 体重: FOLDER_ID のフォルダには保存しない。このスクリプトをデプロイした人のマイドライブに
 * スプレッドシート「insole_体重記録」を作り（最初の1回だけ）、そこに 日付・被験者 ID・体重 を書き込む。
 * 作ったファイルは誰とも共有されないので、デプロイした人だけが見られる。同じ日・同じ被験者は上書きする。
 */
const FOLDER_ID = "ここに保存先フォルダの ID";
const TOKEN = "ここに合言葉";
const WEIGHT_SHEET_NAME = "insole_体重記録";

function doGet() {
  try {
    DriveApp.getFolderById(FOLDER_ID).getName();
    return ContentService.createTextOutput("受け口は動いています。保存先フォルダも見つかりました。");
  } catch (err) {
    return ContentService.createTextOutput("受け口は動いていますが、保存先フォルダが見つかりません: " + err);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return reply_({ ok: false, error: "token" });
    const root = DriveApp.getFolderById(FOLDER_ID);
    if (body.test) return reply_({ ok: true, folder: root.getName() });

    const lock = LockService.getScriptLock();  // 同時に送られても同じフォルダを2つ作らないように
    lock.waitLock(30000);
    try {
      let dir = root;
      (body.folders || []).forEach(name => { dir = child_(dir, safe_(name)); });
      const saved = (body.files || []).map(f => save_(child_(dir, safe_(f.sub || "other")), f));
      if (body.weight) saveWeight_(body.weight);
      return reply_({ ok: true, saved: saved, weight: !!body.weight });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return reply_({ ok: false, error: String(err && err.message || err) });
  }
}

function save_(dir, f) {
  const bytes = f.base64 != null ? Utilities.base64Decode(f.base64) : Utilities.newBlob(f.text || "").getBytes();
  const name = safe_(f.name);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  const digest = md5_(bytes);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : stem + "_" + i + ext;
    const it = dir.getFilesByName(candidate);
    if (!it.hasNext()) {
      dir.createFile(Utilities.newBlob(bytes, f.mimeType || "application/octet-stream", candidate));
      return candidate;
    }
    if (md5_(it.next().getBlob().getBytes()) === digest) return candidate;  // 送信済み（再送）なので何もしない
  }
  throw new Error("同じ名前のファイルが多すぎます: " + name);
}

// 同じ日付・被験者 ID の行があれば上書きし、なければ末尾に足す
function saveWeight_(w) {
  const date = String(w.date || "").replace(/\D/g, "");
  const subject = String(w.subject || "").replace(/[^A-Za-z0-9\-._]/g, "");  // 数式として解釈される文字を入れない
  const kg = Math.round(Number(w.kg) * 10) / 10;
  if (date.length !== 8 || !subject || !(kg >= 5 && kg <= 200)) throw new Error("体重の値が正しくありません");
  const sheet = weightSheet_();
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === date && String(rows[i][1]) === subject) {
      sheet.getRange(i + 1, 3, 1, 2).setValues([[kg, new Date()]]);
      return;
    }
  }
  sheet.appendRow([date, subject, kg, new Date()]);
}

function weightSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("WEIGHT_SHEET_ID");
  if (id) {
    try { return SpreadsheetApp.openById(id).getSheets()[0]; }
    catch (err) { /* 削除された（ゴミ箱を空にした）ときは作り直す */ }
  }
  const ss = SpreadsheetApp.create(WEIGHT_SHEET_NAME);  // マイドライブ直下。共有はしない
  const sheet = ss.getSheets()[0];
  sheet.getRange("A:B").setNumberFormat("@");  // 日付・ID を文字のまま（0001 → 1 にならないように）
  sheet.appendRow(["日付", "被験者 ID", "体重 (kg)", "記録日時"]);
  sheet.setFrozenRows(1);
  props.setProperty("WEIGHT_SHEET_ID", ss.getId());
  return sheet;
}

function child_(dir, name) {
  const it = dir.getFoldersByName(name);
  return it.hasNext() ? it.next() : dir.createFolder(name);
}

function safe_(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, "_").trim() || "noname";
}

function md5_(bytes) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes));
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
