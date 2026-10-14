# API endpoint reference

**Language:** English · [日本語](../ja/api_endpoints.md)

APIs used by this tool. Credentials are not stored in the script. They are read from the spreadsheet at runtime.

---

## Meraki Dashboard API

Base URL: `https://api.meraki.com/api/v1`

Authentication: every request sends `X-Cisco-Meraki-API-Key` (`merakiFetch()`).

When Dry Run is on (`DRY_RUN=TRUE` in `Config`), `merakiRequestSafe()` does not send POST, PUT, or DELETE. It returns `{ dryRun: true }`. GET requests still run.

### Organization / Network

| # | Purpose | Method | Endpoint | Function |
|---|---|---|---|---|
| 1 | List networks in an Organization | GET | `/organizations/{organizationId}/networks?perPage=1000` | `getNetworks()` |
| 2 | Create a network (Golden Network clone) | POST | `/organizations/{organizationId}/networks` | `createNetworkFromGolden()` |
| 3 | Delete a network | DELETE | `/networks/{networkId}` | `deleteNetworksFromSheet()` |

Network listing follows the `Link` response header `rel=next` for up to 100 pages. Each page requests up to 1000 networks.

Golden Network cloning sends `copyFromNetworkId` in the request body. The source network must belong to the same Organization. An ID from another Organization returns `400 Bad Request`. The single `GOLDEN_NETWORK_ID` in Config is used for every row.

### Wireless (MR / SSID)

| # | Purpose | Method | Endpoint | Function |
|---|---|---|---|---|
| 4 | List all SSIDs | GET | `/networks/{networkId}/wireless/ssids` | `backupAllOrgsSettings()`, `checkDiffAllOrgs()` |
| 5 | Get one SSID | GET | `/networks/{networkId}/wireless/ssids/{number}` | `previewSSIDChanges()` |
| 6 | Update an SSID | PUT | `/networks/{networkId}/wireless/ssids/{number}` | `applySSIDToAllOrgs()`, `applySSIDToSingleNetwork()`, `demoResetSSIDs()`, `rollbackAllOrgsSettings()` |

The GET response may include the PSK. That value is stored in plaintext on the backup sheet, so do not share the spreadsheet. The RADIUS shared secret is often omitted from the GET response. In that case the rollback PUT does not include `secret`.

### Appliance (MX / Firewall)

| # | Purpose | Method | Endpoint | Function |
|---|---|---|---|---|
| 7 | Get L3 firewall rules | GET | `/networks/{networkId}/appliance/firewall/l3FirewallRules` | `backupAllOrgsSettings()` |
| 8 | Update L3 firewall rules | PUT | `/networks/{networkId}/appliance/firewall/l3FirewallRules` | `applyFirewallToAllOrgs()`, `applyFirewallToSingleNetwork()`, `demoResetFirewall()`, `rollbackAllOrgsSettings()` |

The demo reset sends `{ "rules": [] }` and removes custom L3 rules.

---

## Webex

Base URL: `https://webexapis.com/v1`

Authentication: `Authorization: Bearer <WEBEX_BOT_TOKEN>`

| # | Purpose | Method | Endpoint | Function |
|---|---|---|---|---|
| 9 | Completion notification | POST | `/messages` | `sendWebexNotification()` |

Request body:

```json
{
  "roomId": "YOUR_WEBEX_ROOM_ID",
  "markdown": "## Completion notice"
}
```

The message is sent only when both `WEBEX_BOT_TOKEN` and `WEBEX_ROOM_ID` are set. If either is missing, the script logs a warning and skips the notification.

---

## GitHub Contents API

Base URL: `https://api.github.com`

Authentication: `Authorization: Bearer <GITHUB_TOKEN>`

| # | Purpose | Method | Endpoint | Function |
|---|---|---|---|---|
| 10 | Create a diff report file | PUT | `/repos/{owner}/{repo}/contents/{path}` | `saveDiffReportToGitHub()` |

Request body:

```json
{
  "message": "Add diff report YYYYMMDD_HHMMSS",
  "content": "<Base64 encoded Markdown>"
}
```

Example path: `reports/diff_report_YYYYMMDD_HHMMSS.md`

This call creates a new file only. It does not send the `sha` required to update an existing file, so running it again for the same path fails. The report contains the comparison table and the diff log. PSK and API key columns are not included.

---

## Rate limits and runtime

The Meraki Dashboard API allows roughly 10 requests per second per Organization. This script waits `Utilities.sleep(300)` after mutating calls, `Utilities.sleep(200)` after diff checks, and `Utilities.sleep(200)` before each extra network-list page.

A large target set can reach the Google Apps Script execution limit of 6 minutes. Narrow the `Active` column on `Organizations` and run in batches.
