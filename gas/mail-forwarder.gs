/**
 * Gmail → 問い合わせ集約システム 転送スクリプト（Google Apps Script）
 *
 * 1分ごとに受信トレイの新着メールを探し、署名付きで /api/mail/ingest に送る。
 * メールの既読・未読やラベルは一切変えない（スタッフの普段のメール運用を邪魔しない）。
 *
 * 初回だけ：
 *   1. プロジェクトの設定 → スクリプト プロパティ に INGEST_URL と INGEST_SECRET を登録
 *   2. エディタで setup を選んで実行（権限を許可）→ 1分ごとのトリガーが作られる
 */

// 前回の確認時刻より少し前から探し直す（Gmail の検索反映の遅れ対策）。重複はサーバー側で弾かれる
var OVERLAP_SEC = 5 * 60;
// 1回の実行で送る上限（GAS の実行時間 6分 に収めるため）
var MAX_MESSAGES_PER_RUN = 30;

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pollInbox').timeBased().everyMinutes(1).create();

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CURSOR_MS')) {
    // 初回は「今から10分前」以降のメールを対象にする（過去メールを大量に送らない）
    props.setProperty('CURSOR_MS', String(Date.now() - 10 * 60 * 1000));
  }
  Logger.log('セットアップ完了：1分ごとに pollInbox が実行されます');
}

function pollInbox() {
  // 前回の実行がまだ終わっていなければ今回は何もしない（同時実行による二重送信を防ぐ）
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;

  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty('INGEST_URL');
    var secret = props.getProperty('INGEST_SECRET');
    if (!url || !secret) throw new Error('スクリプト プロパティ INGEST_URL / INGEST_SECRET が未設定です');

    var cursorMs = Number(props.getProperty('CURSOR_MS') || Date.now());
    var afterSec = Math.floor(cursorMs / 1000) - OVERLAP_SEC;
    var me = Session.getActiveUser().getEmail();

    // 検索は「スレッド単位」で返るので、スレッド内のメッセージを1通ずつ見て時刻で絞る
    var threads = GmailApp.search('in:inbox after:' + afterSec, 0, 50);
    var messages = [];
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (m) {
        if (m.getDate().getTime() / 1000 < afterSec) return;
        if (m.getFrom().indexOf(me) >= 0) return; // 自分が送った返信は問い合わせではない
        messages.push(m);
      });
    });
    messages.sort(function (a, b) { return a.getDate() - b.getDate(); });

    // 直近に送ったメッセージは送り直さない（重なり期間の無駄な送信を減らす。漏れてもサーバーが重複を弾く）
    var cache = CacheService.getScriptCache();
    var sent = 0;
    var newCursorMs = cursorMs;

    for (var i = 0; i < messages.length && sent < MAX_MESSAGES_PER_RUN; i++) {
      var m = messages[i];
      var cacheKey = 'sent_' + m.getId();
      if (cache.get(cacheKey)) {
        newCursorMs = Math.max(newCursorMs, m.getDate().getTime());
        continue;
      }

      var from = parseFrom(m.getFrom());
      var payload = JSON.stringify({
        messageId: m.getId(),
        from: from.email,
        fromName: from.name,
        subject: m.getSubject(),
        body: m.getPlainBody().slice(0, 10000),
        receivedAt: m.getDate().toISOString(),
      });

      var status = postSigned(url, secret, payload);
      if (status !== 200) {
        // 失敗したらここで止める。カーソルを進めないので、次の実行（1分後）でこのメールから再送される
        Logger.log('送信失敗 status=' + status + ' messageId=' + m.getId());
        break;
      }
      cache.put(cacheKey, '1', 60 * 15);
      newCursorMs = Math.max(newCursorMs, m.getDate().getTime());
      sent++;
    }

    props.setProperty('CURSOR_MS', String(newCursorMs));
    if (sent > 0) Logger.log(sent + ' 件を送信しました');
  } finally {
    lock.releaseLock();
  }
}

/** 本文に「タイムスタンプ.本文」の HMAC-SHA256 署名を付けて送る（サーバー側 verifyMailSignature と対） */
function postSigned(url, secret, payload) {
  var timestamp = String(Math.floor(Date.now() / 1000));
  var bytes = Utilities.computeHmacSha256Signature(timestamp + '.' + payload, secret, Utilities.Charset.UTF_8);
  var signature = bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: payload,
    headers: { 'x-timestamp': timestamp, 'x-signature': signature },
    muteHttpExceptions: true,
  });
  return res.getResponseCode();
}

/** 「山田 太郎 <taro@example.com>」→ { name: '山田 太郎', email: 'taro@example.com' } */
function parseFrom(raw) {
  var match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1] || null, email: match[2] };
  return { name: null, email: raw.trim() };
}

/**
 * 署名が合わないときの診断用。秘密鍵そのものは表示せず、長さと指紋（SHA-256の先頭8桁）だけを出す。
 * Claude Code 側で同じ計算をして一致するか比べる。
 */
function checkSecret() {
  var secret = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET') || '';
  var toHex = function (bytes) {
    return bytes.map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    }).join('');
  };
  var fingerprint = toHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret, Utilities.Charset.UTF_8));
  var sample = toHex(Utilities.computeHmacSha256Signature('123.テスト', secret, Utilities.Charset.UTF_8));
  Logger.log('長さ=' + secret.length + ' 指紋=' + fingerprint.slice(0, 8) + ' 署名サンプル=' + sample.slice(0, 8));
}
