# Meraki × Google Spreadsheet Multi-Organization Bulk Configuration Tool

An automated **multi-organization** bulk configuration tool that integrates
Cisco Meraki Dashboard API with Google Spreadsheet.

Unlike a single-network script, this tool manages **multiple Meraki
Organizations at once**: provisioning new networks from a Golden Network,
applying SSID and L3 firewall settings across target Organizations, and
detecting configuration drift between them.

## Overview

Define Organizations and configuration templates in Google Spreadsheet.
The script can provision, configure, compare, and roll back settings across
those Organizations, with Dry Run mode, an approval prompt, and optional
Webex notifications.

This repository does **not** contain API keys, Wi-Fi passwords, or tokens.
Those values stay in your private spreadsheet and are read at runtime.

### Key Features

- Golden Network-based provisioning (clone settings into new networks)
- Bulk SSID configuration across multiple Organizations
- Bulk Firewall (L3) rule configuration across multiple Organizations
- Cross-Org configuration diff check and comparison report
- Backup and generation-based rollback
- Dry Run mode (preview mutating calls without applying them)
- Approval prompt before mutating actions
- Pre-execution change preview
- Webex notification on completion
- Diff report export to GitHub (Markdown)
- Demo reset utilities for SSID and Firewall
- Execution log per Organization

---

## Requirements

| Item | Details |
|------|---------|
| Google Spreadsheet | Google account required |
| Google Apps Script | Included with Spreadsheet |
| Cisco Meraki | Dashboard API enabled for each target Organization |
| Supported Devices | MX (L3 firewall), MR (SSID) |
| Webex (optional) | Bot token and Room ID, for completion notifications |
| GitHub (optional) | Personal access token, for diff report export |

---

## Setup Instructions

### Step 1: Obtain Meraki API Keys (per Organization)

Repeat this for every Organization you want to manage.

#### 1-1. Log in to Meraki Dashboard

https://dashboard.meraki.com

#### 1-2. Enable API Access

Click your account name (top right)
→ My Profile
→ API access section
→ Check "Enable access to the Cisco Meraki Dashboard API"
→ Save

#### 1-3. Generate API Key

My Profile
→ API access section
→ Click "Generate new API key"
→ Copy the displayed API key and save it in a secure location

The API key is only displayed once.

> Each Organization may use a different API key. This tool stores one API
> key per Organization in the `Organizations` sheet. It does not use a
> single global API key, and keys must not be committed to this repository.

#### 1-4. Confirm Organization ID

Meraki Dashboard
→ Scroll to the bottom of any page in that Organization
→ Organization ID is displayed there

Or confirm via:

```
GET https://api.meraki.com/api/v1/organizations
```

#### 1-5. (Optional) Prepare a Golden Network

To provision new networks from an existing baseline, note that network's ID
and enter it in the `Config` sheet as `GOLDEN_NETWORK_ID`.

> `copyFromNetworkId` works only **within the same Organization**. This
> tool has one global Golden Network ID. Organizations that do not own
> that network will fail network creation with HTTP 400 unless you clear
> `GOLDEN_NETWORK_ID` for that run.

---

### Step 2: Google Spreadsheet Setup

#### 2-1. Create a New Spreadsheet

Google Drive → New → Google Sheets → Blank spreadsheet

Keep the spreadsheet private. It will contain API keys and may contain
Wi-Fi PSKs after a backup.

#### 2-2. Create Required Sheets

| Sheet Name | Purpose | Created By |
|-----------|---------|-----------|
| `Config` | Global settings (Dry Run, approval, Golden Network, Webex, GitHub) | Manual |
| `Organizations` | Target Organizations and their API keys | Manual |
| `Template_SSID` | SSID template applied to all Organizations | Manual |
| `Template_Firewall` | L3 firewall template applied to all Organizations | Manual |
| `Network_Provisioning` | New networks to create | Manual |
| `Diff_Report` | Detailed diff results | Auto-created |
| `Comparison_Report` | Cross-Org comparison table | Auto-created |
| `Backup_SSID` | SSID backup history | Auto-created |
| `Backup_Firewall` | Firewall backup history | Auto-created |
| `Log_MultiOrg` | Execution log | Auto-created |

Column layouts: [`docs/sheet_schema_ja.md`](docs/sheet_schema_ja.md).

#### 2-3. Enter Headers and Values in Each Manual Sheet

**Config sheet (column A = key, column B = value):**

| Column A | Column B |
|---|---|
| `DRY_RUN` | `TRUE` |
| `APPROVAL_REQUIRED` | `TRUE` |
| `GOLDEN_NETWORK_ID` | `YOUR_NETWORK_ID` (optional) |
| `WEBEX_BOT_TOKEN` | `YOUR_WEBEX_BOT_TOKEN` (optional) |
| `WEBEX_ROOM_ID` | `YOUR_WEBEX_ROOM_ID` (optional) |
| `GITHUB_TOKEN` | `YOUR_GITHUB_PAT` (optional) |
| `GITHUB_OWNER` | `YOUR_GITHUB_OWNER` (optional) |
| `GITHUB_REPO` | `YOUR_GITHUB_REPO` (optional) |

Set `DRY_RUN` to `TRUE` while testing. Mutating API calls (`POST`, `PUT`,
`DELETE`), including network delete and the demo reset actions, are logged
and not sent.

Set `APPROVAL_REQUIRED` to `TRUE` to require an approver name before bulk
changes, rollback, network delete, and demo resets.

**Organizations sheet (row 1 = header):**

| Org Name | Org ID | API Key | Active |
|---|---|---|---|
| Example_Org_A | YOUR_ORG_ID | YOUR_MERAKI_API_KEY | TRUE |
| Example_Org_B | YOUR_ORG_ID | YOUR_MERAKI_API_KEY | TRUE |
| Example_Org_C | YOUR_ORG_ID | YOUR_MERAKI_API_KEY | FALSE |

Only rows with **Active = TRUE** are processed. `FALSE` excludes an
Organization without deleting the row.

**Template_SSID sheet (row 1 = header):**

`SSID Number | SSID Name | Enabled | Auth Mode | Password | RADIUS Server IP | RADIUS Port | RADIUS Secret | VLAN ID | Bandwidth Limit(Kbps) | (reserved) | IP Mode`

**Template_Firewall sheet (row 1 = header):**

`Policy | Protocol | Source CIDR | Destination CIDR | Source Port | Destination Port | Comment`

**Network_Provisioning sheet (row 1 = header):**

`OrgId | NetworkName | ProductTypes(comma-separated) | TimeZone | Tags(comma-separated) | Approver | Status`

Example row:

`YOUR_ORG_ID | Branch_01 | appliance,switch,wireless | Asia/Tokyo | branch,demo | |`

Leave `Approver` and `Status` blank. They are filled during execution.
If `APPROVAL_REQUIRED = TRUE`, a blank Approver on a provisioning row
skips that row.

#### 2-4. Configure Dropdown Lists (recommended)

**Auth Mode (`Template_SSID`, column D):**

`open`, `WPA2 Personal`, `WPA3 Personal`, `WPA2 Enterprise`, `WPA3 Enterprise`

**Policy (`Template_Firewall`, column A):** `allow`, `deny`

**Protocol (`Template_Firewall`, column B):** `tcp`, `udp`, `icmp`, `any`

**Active / Enabled:** `TRUE`, `FALSE`

---

### Step 3: Google Apps Script Setup

#### 3-1. Open Apps Script Editor

Spreadsheet menu → Extensions → Apps Script

#### 3-2. Paste the Script

Delete the default code, paste [`gas/meraki_multi_org.gs`](gas/meraki_multi_org.gs), and save.

#### 3-3. Authorize

In the Apps Script editor, select `onOpen`, click Run, and allow the
requested permissions.

#### 3-4. Verify the Custom Menu

Return to the spreadsheet and confirm **🌏 Meraki Multi-Org 設定** appears.
The menu and dialogs are in Japanese.

---

### Step 4: Dry Run First

Confirm `DRY_RUN = TRUE` on the `Config` sheet, then run a bulk action.
Mutating calls are recorded as `🧪 DRY RUN` in `Log_MultiOrg`.
Set `DRY_RUN = FALSE` only after the log looks right.

---

### Step 5: Verify Operation

1. 🌏 Meraki Multi-Org 設定 → 🏗 新規Networkを作成する（Golden Network方式）
2. 🌏 Meraki Multi-Org 設定 → 💾 全Orgの設定をバックアップする
3. 🌏 Meraki Multi-Org 設定 → 📶 全OrgにSSID設定を反映する
4. 🌏 Meraki Multi-Org 設定 → 🔒 全OrgにFWルールを反映する
5. 🌏 Meraki Multi-Org 設定 → 🔍 全Orgの設定差分をチェックする
6. 🌏 Meraki Multi-Org 設定 → 🗑 作成済みNetworkを削除する（デモ用クリーンアップ）

---

## Full Menu Reference

| Menu Item | Function | Mutating? |
|---|---|---|
| 🏗 新規Networkを作成する（Golden Network方式） | Create networks from `Network_Provisioning`, cloning the Golden Network when set | Yes |
| 🗑 作成済みNetworkを削除する（デモ用クリーンアップ） | Delete networks this tool previously created | Yes (irreversible) |
| 📶 全OrgにSSID設定を反映する | Apply `Template_SSID` to Active Organizations | Yes |
| 🔒 全OrgにFWルールを反映する | Apply `Template_Firewall` to Active Organizations | Yes |
| 🔍 全Orgの設定差分をチェックする | Compare live settings with the SSID template | No (read-only) |
| 💾 全Orgの設定をバックアップする | Append a new SSID/Firewall snapshot | No (read-only) |
| ⏪ バックアップからロールバックする | Restore a selected backup generation | Yes |
| 📤 差分レポートをGitHubに保存する | Export the latest comparison as Markdown | External write |
| 🧪 【デモ】SSIDを初期化(Test0/1/2/Open) | Reset SSID 0–2 to an open demo baseline | Yes |
| 🧪 【デモ】Firewallを初期化(Allow Any) | Clear custom L3 firewall rules | Yes |

---

## Repository Structure

```
meraki-multiorg-spreadsheet-automation/
├── README.md
├── LICENSE
├── gas/
│   └── meraki_multi_org.gs
└── docs/
    ├── sheet_schema_ja.md
    └── api_endpoints.md
```

---

## Known Limitations

- Golden Network cloning uses one `GOLDEN_NETWORK_ID` for every row. It succeeds only in the Organization that owns that network.
- `Backup_SSID` stores the PSK when the Meraki GET response includes it. Treat that sheet as secret. Do not export or commit it.
- The SSID GET response often omits the RADIUS shared secret. Rollback then updates the RADIUS host and port without sending an empty secret. If Meraki requires the secret on update, that SSID restore fails and is logged.
- Firewall backup does not store the rule comment, so rollback restores policy, protocol, CIDR, and ports only.
- Rollback does not store WPA2/WPA3 encryption subtype. Enterprise restore sends `WPA2 only`.
- GitHub export creates a new file. Updating an existing path needs the blob `sha`, which this script does not send, so the same file name cannot be overwritten.
- Network list calls follow Meraki pagination (`perPage=1000` plus `Link: rel=next`). Very large Organizations can still approach the Apps Script 6-minute limit. Narrow `Active` and run in batches.
- Networks bound to a Meraki configuration template may reject per-network SSID or firewall updates.
- VLAN template provisioning is not implemented.

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|---------|
| `API Error 401` | Invalid API key for that Organization | Re-check the API Key column in `Organizations` |
| `API Error 404` | Incorrect Org ID or Network ID | Re-check IDs in Dashboard |
| `API Error 400` on network creation | `copyFromNetworkId` points at another Organization | Use a Golden Network in the same Org, or leave `GOLDEN_NETWORK_ID` blank |
| `❌ 対象のOrganizationが見つかりません` | No `Active = TRUE` row | Set at least one Active cell to `TRUE` |
| `⚠️ 承認者未入力のためスキップ` | Provisioning row has no approver while approval is required | Enter an approver, or set `APPROVAL_REQUIRED` to `FALSE` |
| `⚠️ 同名Networkが既に存在します` | That name already exists in the Org | Rename the row or skip it |
| Webex notification not sent | Bot token or room ID missing | Optional. Set both Config values to enable it |
| GitHub save fails | Token, owner, or repo missing, or the token cannot write contents | Check the three Config values and token scope |
| Menu not displayed | Authorization incomplete | Re-run `onOpen` and grant permissions |

---

## API Endpoints Used

See [`docs/api_endpoints.md`](docs/api_endpoints.md).

---

## References

- [Cisco Meraki Dashboard API Documentation](https://developer.cisco.com/meraki/api-v1/)
- [Google Apps Script Documentation](https://developers.google.com/apps-script)
- [Webex Messages API](https://developer.webex.com/docs/api/v1/messages)
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents)
- [Meraki Developer Hub](https://developer.cisco.com/meraki/)

---

## License

MIT License. See [LICENSE](LICENSE).

---

## Disclaimer

This tool is provided **as is**, without warranty.

### General

- The author assumes no responsibility for damage or loss from using this tool.
- You are responsible for configuration and use.
- Back up network configuration before making changes.

### Meraki API

- Usage of the Cisco Meraki Dashboard API is subject to the [Meraki API Terms of Service](https://meraki.cisco.com/support/#api).
- Manage API keys per Organization. Do not share them or place them in a public repository.
- This tool is **not officially supported by Cisco or Meraki**. It is an independent project.

### Multi-Organization Impact

- One template can change many Organizations in a single run.
- Run with `DRY_RUN = TRUE` first and review `Log_MultiOrg` before turning Dry Run off.
- `copyFromNetworkId` works only inside the same Organization.
- Rollback restores a selected backup generation. It does not guarantee full recovery if devices or networks changed after the backup.

### Google Spreadsheet and Apps Script

- The script calls the Meraki, Webex, and GitHub APIs from Google Apps Script, subject to [Google's Terms of Service](https://policies.google.com/terms).
- You are responsible for spreadsheet access. The sheet holds API keys for every Organization you list, and `Backup_SSID` may hold PSKs.

## Author

Knishiji(Per)
