# Sheet schema reference

**Language:** English · [日本語](../ja/sheet_schema.md)

Column layout for the spreadsheet used by `gas/meraki_multi_org.gs`.
Column numbers start at **1**, matching the spreadsheet display.

This repository does not include the spreadsheet itself. Keep API keys, PSKs, and tokens only in the private spreadsheet.

---

## Sheets you create manually

### 1. `Config`

Column A is the key. Column B is the value.

| Row | Column A (key) | Column B (value) | Required | Description |
|---|---|---|---|---|
| 1 | `DRY_RUN` | `TRUE` / `FALSE` | Recommended | When `TRUE`, POST / PUT / DELETE are logged and not sent. Network deletion and demo resets are included |
| 2 | `APPROVAL_REQUIRED` | `TRUE` / `FALSE` | Recommended | When `TRUE`, bulk apply, delete, rollback, and demo reset ask for an approver name. Network creation uses the Approver column on each row |
| 3 | `GOLDEN_NETWORK_ID` | Network ID | Optional | Source network when creating a new network. Valid only inside the same Organization. Every row uses this single value |
| 4 | `WEBEX_BOT_TOKEN` | Webex bot token | Optional | Required only for completion notifications |
| 5 | `WEBEX_ROOM_ID` | Webex room ID | Optional | Notification destination |
| 6 | `GITHUB_TOKEN` | GitHub personal access token | Optional | Used to save the diff report. The token needs permission to write repository contents |
| 7 | `GITHUB_OWNER` | GitHub user or organization | Optional | Owner of the destination repository |
| 8 | `GITHUB_REPO` | Repository name | Optional | Destination repository |

Used by `getConfig()`.

---

### 2. `Organizations`

Row 1 is the header. Data starts on row 2.

| Column | Name | Type | Description |
|---|---|---|---|
| A | Org Name | String | Display name used in logs and notifications |
| B | Org ID | String | Meraki Organization ID |
| C | API Key | String | Meraki API key for that Organization |
| D | Active | `TRUE` / `FALSE` | Only `TRUE` rows are processed. A checkbox boolean is also accepted |

Used by `getOrganizations()`. Column D is evaluated by `isActiveFlag()`.

---

### 3. `Template_SSID`

SSID template applied to every Organization. Row 1 is the header.

| Column | Name | Type | Description |
|---|---|---|---|
| A (`row[0]`) | SSID Number | Number | SSID number (0–14) |
| B (`row[1]`) | SSID Name | String | SSID name |
| C (`row[2]`) | Enabled | `TRUE` / `FALSE` | Enabled or disabled |
| D (`row[3]`) | Auth Mode | String | `open` / `WPA2 Personal` / `WPA3 Personal` / `WPA2 Enterprise` / `WPA3 Enterprise`. Letter case and extra spaces are normalized |
| E (`row[4]`) | Password | String | PSK |
| F (`row[5]`) | RADIUS Server IP | String | RADIUS server for Enterprise authentication |
| G (`row[6]`) | RADIUS Port | Number | 1812 when blank |
| H (`row[7]`) | RADIUS Secret | String | RADIUS shared secret |
| I (`row[8]`) | VLAN ID | Number | Blank means no VLAN tagging |
| J (`row[9]`) | Bandwidth Limit(Kbps) | Number | Per-client bandwidth. Blank means no limit |
| K (`row[10]`) | (unused) | - | Not read by the script |
| L (`row[11]`) | IP Mode | String | `NAT mode` / `Bridge mode` / `Layer 3 roaming`. Blank defaults to `Bridge mode` |

If IP Mode does not contain Bridge or Layer 3 (for example NAT mode), `sanitizeVlanTagging()` forces `useVlanTagging` to `false`. The diff check uses the same rule.

`wpaEncryptionMode` is `WPA3 Transition Mode` for WPA3 Personal and WPA3 Enterprise, and `WPA2 only` for WPA2.

Used by `buildSSIDPayloadFromTemplateRow()`.

On the first apply, these columns are added if they are missing.

| Added column | Description |
|---|---|
| ステータス | Latest apply result |
| 最終更新日時 | Time of the latest apply |

---

### 4. `Template_Firewall`

L3 firewall rules for MX. Rules are evaluated from top to bottom.

| Column | Name | Type | Description |
|---|---|---|---|
| A (`row[0]`) | Policy | String | `allow` / `deny`. Japanese values such as `許可` and `拒否` are normalized |
| B (`row[1]`) | Protocol | String | `tcp` / `udp` / `icmp` / `any` |
| C (`row[2]`) | Source CIDR | String | Blank becomes `Any` |
| D (`row[3]`) | Destination CIDR | String | Blank becomes `Any` |
| E (`row[4]`) | Source Port | String | Blank becomes `Any` |
| F (`row[5]`) | Destination Port | String | Blank becomes `Any` |
| G (`row[6]`) | Comment | String | Optional. Sent on apply. Not stored in the backup |

Meraki appends an implicit trailing rule. Place required `allow` rules above `deny` rules.

Used by `buildFirewallRulesFromTemplate()`, `normalizeFWPolicy()`, `normalizeFWProtocol()`, and `normalizeFWPort()`.

---

### 5. `Network_Provisioning`

Networks to create.

| Column | Name | Type | Description |
|---|---|---|---|
| OrgId | OrgId | String | Must match an Org ID on `Organizations` |
| NetworkName | NetworkName | String | Must be unique inside the Organization |
| ProductTypes(カンマ区切り) | ProductTypes | String | Example: `appliance,switch,wireless` |
| TimeZone | TimeZone | String | Example: `Asia/Tokyo` |
| Tags(カンマ区切り) | Tags | String | May be blank |
| 承認者 | Approver | String | Required when `APPROVAL_REQUIRED=TRUE`. A blank row is skipped |
| ステータス | Status | String | Creation result. Delete reads the Network ID from this text |

Delete selects rows whose status contains an ID in the form `ID: N_...` or `ID: L_...`. A Dry Run delete status keeps that ID, so a later real run can still find the network.

Used by `provisionNetworksFromSheet()`, `createNetworkFromGolden()`, and `deleteNetworksFromSheet()`.

---

## Sheets created automatically

### 6. `Diff_Report`

| Column | Name |
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

PSK and RADIUS secrets are not written to the diff report.

### 7. `Comparison_Report`

Columns grow with the number of Organizations in the run:
`設定項目` → `基準値 (Template)` → one column per Organization → `総合判定`.

### 8. `Backup_SSID`

| Column | Name |
|---|---|
| A | バックアップ日時 (generation key) |
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

Columns J and O are secrets. If the GET response includes a PSK, it is stored in plaintext. The RADIUS secret is often absent from the GET response and stays blank. Rollback does not send an empty secret back, so an existing secret is not cleared by a blank cell.

Rows that share the same timestamp in column A are one generation. Rollback selects a generation by that timestamp (`getAvailableBackupTimestamps()`).

### 9. `Backup_Firewall`

| Column | Name |
|---|---|
| A | バックアップ日時 (generation key) |
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

There is no comment column. After rollback, rule comments are empty.

### 10. `Log_MultiOrg`

| Column | Name |
|---|---|
| A | 実行日時 |
| B | 実行者 |
| C | Org名 |
| D | 実行内容 |
| E | 対象 |
| F | 結果 |
| G | 承認者 |

---

## If you change columns

The script reads columns as zero-based `row[0]`, `row[1]`, and so on. If you add or reorder columns, update the indexes in the matching functions.

- `buildSSIDPayloadFromTemplateRow()`
- `buildFirewallRulesFromTemplate()`
- `getOrganizations()`
- `provisionNetworksFromSheet()`
- `rollbackAllOrgsSettings()`
