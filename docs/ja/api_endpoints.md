# API エンドポイントリファレンス

**言語:** [English](../en/api_endpoints.md) · 日本語

このツールが使うAPIの一覧です。認証情報はコードに書きません。実行時にスプレッドシートから読みます。

---

## Meraki Dashboard API

Base URL: `https://api.meraki.com/api/v1`

認証: すべてのリクエストに `X-Cisco-Meraki-API-Key` を付けます（`merakiFetch()`）。

Dry Run（`Config` の `DRY_RUN=TRUE`）のとき、`merakiRequestSafe()` は POST / PUT / DELETE を送らず `{ dryRun: true }` を返します。GET はそのまま実行します。

### Organization / Network

| # | 用途 | Method | Endpoint | 利用関数 |
|---|---|---|---|---|
| 1 | Organization配下のNetwork一覧 | GET | `/organizations/{organizationId}/networks?perPage=1000` | `getNetworks()` |
| 2 | 新規Network作成（Golden Networkクローン対応） | POST | `/organizations/{organizationId}/networks` | `createNetworkFromGolden()` |
| 3 | Network削除 | DELETE | `/networks/{networkId}` | `deleteNetworksFromSheet()` |

Network一覧は応答ヘッダー `Link` の `rel=next` を最大100ページまでたどります。既定の1ページは最大1000件です。

Golden Network cloning はリクエストボディの `copyFromNetworkId` で行います。コピー元は同じOrganizationのNetworkだけです。別OrganizationのIDだと `400 Bad Request` になります。`GOLDEN_NETWORK_ID` はConfigの1件を全行に使います。

### Wireless (MR / SSID)

| # | 用途 | Method | Endpoint | 利用関数 |
|---|---|---|---|---|
| 4 | 全SSID一覧取得 | GET | `/networks/{networkId}/wireless/ssids` | `backupAllOrgsSettings()`, `checkDiffAllOrgs()` |
| 5 | 個別SSID取得 | GET | `/networks/{networkId}/wireless/ssids/{number}` | `previewSSIDChanges()` |
| 6 | SSID設定更新 | PUT | `/networks/{networkId}/wireless/ssids/{number}` | `applySSIDToAllOrgs()`, `applySSIDToSingleNetwork()`, `demoResetSSIDs()`, `rollbackAllOrgsSettings()` |

GET応答にPSKが含まれることがあります。バックアップシートに平文で保存されるため、スプレッドシートは共有しないでください。RADIUS共有シークレットはGET応答に含まれないことが多く、その場合ロールバックのPUTには `secret` を含めません。

### Appliance (MX / Firewall)

| # | 用途 | Method | Endpoint | 利用関数 |
|---|---|---|---|---|
| 7 | L3 Firewallルール取得 | GET | `/networks/{networkId}/appliance/firewall/l3FirewallRules` | `backupAllOrgsSettings()` |
| 8 | L3 Firewallルール更新 | PUT | `/networks/{networkId}/appliance/firewall/l3FirewallRules` | `applyFirewallToAllOrgs()`, `applyFirewallToSingleNetwork()`, `demoResetFirewall()`, `rollbackAllOrgsSettings()` |

デモ初期化は `{ "rules": [] }` を送り、カスタムL3ルールを外します。

---

## Webex

Base URL: `https://webexapis.com/v1`

認証: `Authorization: Bearer <WEBEX_BOT_TOKEN>`

| # | 用途 | Method | Endpoint | 利用関数 |
|---|---|---|---|---|
| 9 | 完了通知 | POST | `/messages` | `sendWebexNotification()` |

リクエストボディ:

```json
{
  "roomId": "YOUR_WEBEX_ROOM_ID",
  "markdown": "## 処理完了通知"
}
```

`WEBEX_BOT_TOKEN` と `WEBEX_ROOM_ID` が両方あるときだけ送信します。未設定ならログに警告を出してスキップします。

---

## GitHub Contents API

Base URL: `https://api.github.com`

認証: `Authorization: Bearer <GITHUB_TOKEN>`

| # | 用途 | Method | Endpoint | 利用関数 |
|---|---|---|---|---|
| 10 | 差分レポートの新規作成 | PUT | `/repos/{owner}/{repo}/contents/{path}` | `saveDiffReportToGitHub()` |

リクエストボディ:

```json
{
  "message": "Add diff report YYYYMMDD_HHMMSS",
  "content": "<Base64 encoded Markdown>"
}
```

保存先の例: `reports/diff_report_YYYYMMDD_HHMMSS.md`

この処理は新規ファイル作成だけです。既存ファイルの更新に必要な `sha` は送りません。同じパスへの再実行は失敗します。比較表と差分ログだけを書き、PSKやAPIキーはレポート列に含めていません。

---

## レート制限と実行時間

Meraki Dashboard API は Organization 単位でおおよそ秒間10リクエストの制限があります。このスクリプトは変更系コールのあと `Utilities.sleep(300)`、差分チェックのあと `Utilities.sleep(200)`、Network一覧の次ページの前に `Utilities.sleep(200)` を入れています。

対象が多いと Google Apps Script の実行時間上限（6分）に達します。そのときは `Organizations` の Active 列で対象を分けて実行してください。
