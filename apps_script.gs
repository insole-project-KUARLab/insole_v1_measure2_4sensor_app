/**
 * インソール計測アプリ（4センサー版）→ Google ドライブの受け口（Google Apps Script）
 *
 * 5センサー版アプリと同じ形式で受け取るので、すでにデプロイ済みの受け口があればそれをそのまま使えます。
 * 新しく作るときだけ、これを script.google.com の新しいプロジェクトに貼り付けてください（手順は README.md）。
 *
 * 保存先: FOLDER_ID のフォルダ / <記録した日付> / <被験者 ID> / csv（または png） / ファイル
 * 同じ名前で中身が同じファイルがあれば何もしない。中身が違えば上書きせずに _2, _3 … を付けて保存する。
 *
 * 体重と靴の写真: FOLDER_ID のフォルダには保存しない。このスクリプトをデプロイした人のマイドライブに
 * スプレッドシート「insole_体重記録」とフォルダ「insole_靴の写真」を作り（最初の1回だけ）、
 * 表に 日付・被験者 ID・体重・写真の URL を書き込む。写真はフォルダに保存する。
 * 作ったファイルは誰とも共有されないので、デプロイした人だけが見られる。同じ日・同じ被験者は上書きする。
 */
const FOLDER_ID = "ここに保存先フォルダの ID";
const TOKEN = "ここに合言葉";
const WEIGHT_SHEET_NAME = "insole_体重記録";
const SHOE_FOLDER_NAME = "insole_靴の写真";
// 靴の写真を入れるフォルダを自分で決めるときは、そのフォルダの ID を書く（URL の folders/ のあとの英数字）。
// 空のままなら、マイドライブ直下に SHOE_FOLDER_NAME のフォルダを自動で作る
const SHOE_FOLDER_ID = "";
const HEADER = ["日付", "被験者 ID", "体重 (kg)", "記録日時", "靴の写真"];

// 体重・靴の写真の保存を使う前に、エディタでこの関数を選んで「実行」を一度押す。
// 許可の画面が出たら許可する（デプロイし直すだけでは許可の画面が出ない）。
// 表とフォルダがまだなければ、ここで作られる。場所は「実行ログ」に出る
function setup() {
  const sheet = weightSheet_();
  Logger.log("体重の表: " + sheet.getParent().getUrl());
  Logger.log("靴の写真のフォルダ: " + shoeFolder_().getUrl());
}

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
      if (body.shoe) saveShoe_(body.shoe);
      return reply_({ ok: true, saved: saved, weight: !!body.weight, shoe: !!body.shoe });
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

function saveWeight_(w) {
  const day = day_(w);
  const kg = Math.round(Number(w.kg) * 10) / 10;
  if (!(kg >= 5 && kg <= 200)) throw new Error("体重の値が正しくありません");
  const sheet = weightSheet_();
  const row = dayRow_(sheet, day);
  sheet.getRange(row, 3, 1, 2).setValues([[kg, new Date()]]);
}

// 靴の写真は SHOE_FOLDER_NAME のフォルダに「日付_被験者ID.jpg」で保存し、表の同じ行に写真の URL を書く。
// 同じ日・同じ被験者で撮り直したときは、前の写真をゴミ箱に移して入れ替える
function saveShoe_(p) {
  const day = day_(p);
  if (!p.base64) throw new Error("靴の写真がありません");
  const folder = shoeFolder_();
  const name = day.date + "_" + day.subject + ".jpg";
  const old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.base64), "image/jpeg", name));
  const sheet = weightSheet_();
  const row = dayRow_(sheet, day);
  sheet.getRange(row, 4, 1, 2).setValues([[new Date(), file.getUrl()]]);
}

function day_(x) {
  const date = String(x.date || "").replace(/\D/g, "");
  const subject = String(x.subject || "").replace(/[^A-Za-z0-9\-._]/g, "");  // 数式として解釈される文字を入れない
  if (date.length !== 8 || !subject) throw new Error("日付か被験者 ID が正しくありません");
  return { date: date, subject: subject };
}

// 同じ日付・被験者 ID の行の番号。なければ末尾に行を足す（日付は表の上で日付として扱えるように Date で書く）
function dayRow_(sheet, day) {
  const tz = sheet.getParent().getSpreadsheetTimeZone();
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (ymd_(rows[i][0], tz) === day.date && String(rows[i][1]) === day.subject) return i + 1;
  }
  sheet.appendRow([toDate_(day.date, tz), day.subject]);
  return sheet.getLastRow();
}

// 表の日付のセル（Date。古い行は 20261113 のような数字や文字）を "20261113" にそろえる
function ymd_(v, tz) {
  return v instanceof Date ? Utilities.formatDate(v, tz, "yyyyMMdd") : String(v).replace(/\D/g, "");
}

function toDate_(ymd, tz) {
  return Utilities.parseDate(ymd, tz, "yyyyMMdd");
}

function shoeFolder_() {
  if (SHOE_FOLDER_ID) {
    try { return DriveApp.getFolderById(SHOE_FOLDER_ID); }
    catch (err) { throw new Error("靴の写真のフォルダを開けません。Apps Script の SHOE_FOLDER_ID を確認してください"); }
  }
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("SHOE_FOLDER_ID");
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* 削除されたときは作り直す */ }
  }
  const folder = DriveApp.createFolder(SHOE_FOLDER_NAME);  // マイドライブ直下。共有はしない
  props.setProperty("SHOE_FOLDER_ID", folder.getId());
  return folder;
}

function weightSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("WEIGHT_SHEET_ID");
  if (id) {
    try { return withHeader_(SpreadsheetApp.openById(id).getSheets()[0]); }
    catch (err) { /* 削除された（ゴミ箱を空にした）ときは作り直す */ }
  }
  const ss = SpreadsheetApp.create(WEIGHT_SHEET_NAME);  // マイドライブ直下。共有はしない
  const sheet = ss.getSheets()[0];
  sheet.getRange("B:B").setNumberFormat("@");  // ID を文字のまま（0001 → 1 にならないように）
  sheet.appendRow(HEADER);
  sheet.setFrozenRows(1);
  props.setProperty("WEIGHT_SHEET_ID", ss.getId());
  return withHeader_(sheet);
}

// 表の形を整える。古い版で作った表もここで直る
// - 靴の写真の列ができる前に作った表にも、見出しを足す
// - 日付の列を日付として表示し、20261113 のような数字・文字で入っている古い行は日付に直す
// - 記録日時は時刻まで表示する（行を先に作ってからあとで日時を書くと、日付だけの表示になることがあるため）
function withHeader_(sheet) {
  if (sheet.getRange(1, HEADER.length).getValue() === "") sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  sheet.getRange("A2:A").setNumberFormat("yyyy/mm/dd");
  sheet.getRange("D2:D").setNumberFormat("yyyy/mm/dd hh:mm:ss");
  const n = sheet.getLastRow();
  if (n >= 2) {
    const tz = sheet.getParent().getSpreadsheetTimeZone();
    const range = sheet.getRange(2, 1, n - 1, 1), values = range.getValues();
    let changed = false;
    const fixed = values.map(([v]) => {
      if (v instanceof Date || v === "") return [v];
      const s = String(v).replace(/\D/g, "");
      if (s.length !== 8) return [v];
      changed = true;
      return [toDate_(s, tz)];
    });
    if (changed) range.setValues(fixed);
  }
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
