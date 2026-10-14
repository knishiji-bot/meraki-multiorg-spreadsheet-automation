# シート構成リファレンス

`gas/meraki_multi_org.gs` が使うスプレッドシートの列構成です。
列番号は **1列目を1** として記載しています。

このリポジトリにスプレッドシート本体は含めません。APIキー、PSK、トークンは非公開のスプレッドシートだけに置いてください。

---

## 手動作成が必要なシート

### 1. `Config`

A列にキー、B列に値を入力します。

| 行 | A列（キー） | B列（値） | 必須 | 説明 |
|---|---|---|---|---|
| 1 | `DRY_RUN` | `TRUE` / `FALSE` | 推奨 | `TRUE` のとき POST / PUT / DELETE を送らずログのみ。Network削除とデモ初期化も対象 |
| 2 | `APPROVAL_REQUIRED` | `TRUE` / `FALSE` | 推奨 | `TRUE` のとき一括反映、削除、ロールバック、デモ初期化の前に承認者名を要求。Network作成は行ごとの「承認者」列を使う |
| 3 | `GOLDEN_NETWORK_ID` | Network ID | 任意 | 新規Network作成時のコピー元。同一Organization内だけ有効。全行でこの1件を使う |
| 4 | `WEBEX_BOT_TOKEN` | Webex Botトークン | 任意 | 完了通知を送る場合 |
| 5 | `WEBEX_ROOM_ID` | WebexルームID | 任意 | 通知先 |
| 6 | `GITHUB_TOKEN` | GitHub Personal Access Token | 任意 | 差分レポート保存用。contents の書き込みができる権限が必要 |
| 7 | `GITHUB_OWNER` | GitHubユーザー名またはOrganization名 | 任意 | 保存先の所有者 |
| 8 | `GITHUB_REPO` | リポジトリ名 | 任意 | 保存先リポジトリ |

参照: `getConfig()`

---

### 2. `Organizations`

1行目はヘッダー、2行目以降がデータです。

| 列 | 項目名 | 型 | 説明 |
|---|---|---|---|
| A | Org Name | 文字列 | ログと通知に使う表示名 |
| B | Org ID | 文字列 | Meraki Organization ID |
| C | API Key | 文字列 | そのOrganization用のMeraki APIキー |
| D | Active | `TRUE` / `FALSE` | `TRUE` の行だけ一括処理の対象。チェックボックスの真偽値も可 |

参照: `getOrganizations()`（D列は `isActiveFlag()` で判定）

---

### 3. `Template_SSID`

全Organizationへ適用するSSIDテンプレートです。1行目はヘッダーです。

| 列 | 項目名 | 型 | 説明 |
|---|---|---|---|
| A (`row[0]`) | SSID Number | 数値 | SSID番号（0〜14） |
| B (`row[1]`) | SSID Name | 文字列 | SSID名 |
| C (`row[2]`) | Enabled | `TRUE` / `FALSE` | 有効/無効 |
| D (`row[3]`) | Auth Mode | 文字列 | `open` / `WPA2 Personal` / `WPA3 Personal` / `WPA2 Enterprise` / `WPA3 Enterprise`。大文字小文字と余分な空白は正規化される |
| E (`row[4]`) | Password | 文字列 | PSK |
| F (`row[5]`) | RADIUS Server IP | 文字列 | Enterprise認証のRADIUSサーバー |
| G (`row[6]`) | RADIUS Port | 数値 | 空欄時は 1812 |
| H (`row[7]`) | RADIUS Secret | 文字列 | RADIUS共有シークレット |
| I (`row[8]`) | VLAN ID | 数値 | 空欄ならVLANタギングなし |
| J (`row[9]`) | Bandwidth Limit(Kbps) | 数値 | クライアント毎の帯域。空欄なら制限なし |
| K (`row[10]`) | （未使用） | - | スクリプトは参照しない |
| L (`row[11]`) | IP Mode | 文字列 | `NAT mode` / `Bridge mode` / `Layer 3 roaming`。空欄時は `Bridge mode` |

`useVlanTagging` は、IP Mode が Bridge または Layer 3 を含まない場合（NAT mode など）に `sanitizeVlanTagging()` で `false` に補正されます。差分チェックも同じ判定です。

WPA3 Personal / WPA3 Enterprise の `wpaEncryptionMode` は `WPA3 Transition Mode` です。WPA2 は `WPA2 only` です。

参照: `buildSSIDPayloadFromTemplateRow()`

初回反映時に、次の列が無ければ自動追加されます。

| 自動追加列 | 説明 |
|---|---|
| ステータス | 直近の反映結果 |
| 最終更新日時 | 最後に反映した日時 |

---

### 4. `Template_Firewall`

MXのL3 Firewallルールです。上の行から評価されます。

| 列 | 項目名 | 型 | 説明 |
|---|---|---|---|
| A (`row[0]`) | Policy | 文字列 | `allow` / `deny`。`許可` `拒否` なども正規化 |
| B (`row[1]`) | Protocol | 文字列 | `tcp` / `udp` / `icmp` / `any` |
| C (`row[2]`) | Source CIDR | 文字列 | 空欄は `Any` |
| D (`row[3]`) | Destination CIDR | 文字列 | 空欄は `Any` |
| E (`row[4]`) | Source Port | 文字列 | 空欄は `Any` |
| F (`row[5]`) | Destination Port | 文字列 | 空欄は `Any` |
| G (`row[6]`) | Comment | 文字列 | 任意。反映時には送る。バックアップには保存しない |

Meraki側には末尾の暗黙ルールがあるため、必要な `allow` は `deny` より上の行に置いてください。

参照: `buildFirewallRulesFromTemplate()`, `normalizeFWPolicy()`, `normalizeFWProtocol()`, `normalizeFWPort()`

---

### 5. `Network_Provisioning`

新規作成するNetworkの一覧です。

| 列 | 項目名 | 型 | 説明 |
|---|---|---|---|
| OrgId | OrgId | 文字列 | `Organizations` の Org ID と一致させる |
| NetworkName | NetworkName | 文字列 | Org内で重複不可 |
| ProductTypes(カンマ区切り) | ProductTypes | 文字列 | 例: `appliance,switch,wireless` |
| TimeZone | TimeZone | 文字列 | 例: `Asia/Tokyo` |
| Tags(カンマ区切り) | Tags | 文字列 | 空欄可 |
| 承認者 | Approver | 文字列 | `APPROVAL_REQUIRED=TRUE` のとき必須。空欄行はスキップ |
| ステータス | Status | 文字列 | 作成結果。削除処理はここから Network ID を抽出する |

削除対象の判定は、ステータス文字列に対する `ID: N_...` または `ID: L_...` 形式の抽出です。Dry Run の削除予定ステータスも ID を残すため、あとから本実行できます。

参照: `provisionNetworksFromSheet()`, `createNetworkFromGolden()`, `deleteNetworksFromSheet()`

---

## 自動生成されるシート

### 6. `Diff_Report`

| 列 | 項目名 |
|---|---|
| A | チェック日時 |
| B | Org名 |
| C | Network名 |
| D | 設定項目 |
| E | 期待値 |
| F | 実際の値 |
| G | 結果 |
| H | ステータス |
| I | 最終更新日時 |

PSK と RADIUSシークレットは差分レポートに書きません。

### 7. `Comparison_Report`

実行時のOrganization数に応じて列が増えます。
`設定項目` → `基準値 (Template)` → 各Org列 → `総合判定`

### 8. `Backup_SSID`

| 列 | 項目名 |
|---|---|
| A | バックアップ日時（世代識別キー） |
| B | Org名 |
| C | Org ID |
| D | Network名 |
| E | Network ID |
| F | SSID番号 |
| G | SSID名 |
| H | 有効/無効 |
| I | 認証モード |
| J | PSK |
| K | VLANタギング |
| L | IPモード |
| M | RADIUS IP |
| N | RADIUSポート |
| O | RADIUSシークレット |

J列とO列は秘密情報です。GET応答にPSKが含まれると平文で保存されます。RADIUSシークレットはGET応答に含まれないことが多く、その場合は空欄です。空のシークレットをロールバック時に送り直して既存値を消さないようにしています。

A列の「バックアップ日時」が同じ行が1つの世代です。ロールバックはこの日時単位で選びます（`getAvailableBackupTimestamps()`）。

### 9. `Backup_Firewall`

| 列 | 項目名 |
|---|---|
| A | バックアップ日時（世代識別キー） |
| B | Org名 |
| C | Org ID |
| D | Network名 |
| E | Network ID |
| F | ポリシー |
| G | プロトコル |
| H | 送信元CIDR |
| I | 宛先CIDR |
| J | 送信元ポート |
| K | 宛先ポート |

コメント列はありません。ロールバック後のルールコメントは空になります。

### 10. `Log_MultiOrg`

| 列 | 項目名 |
|---|---|
| A | 実行日時 |
| B | 実行者 |
| C | Org名 |
| D | 実行内容 |
| E | 対象 |
| F | 結果 |
| G | 承認者 |

---

## 列を変えるときの注意

GASは `row[0]`, `row[1]` のように0始まりで列を参照します。列の追加や入れ替えをするときは、対応する関数の添字も直してください。

- `buildSSIDPayloadFromTemplateRow()`
- `buildFirewallRulesFromTemplate()`
- `getOrganizations()`
- `provisionNetworksFromSheet()`
- `rollbackAllOrgsSettings()`
