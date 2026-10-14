// ============================================================
// Cisco Meraki Multi-Organization Bulk Configuration
// Google Apps Script（単独スプレッドシート版）
//
// Credentials are never hardcoded. Meraki API keys, Webex tokens,
// and GitHub tokens are read at runtime from the private spreadsheet
// (Config / Organizations). Do not commit that spreadsheet.
// ============================================================

const SHEET_CONFIG  = 'Config';
const BASE_URL      = 'https://api.meraki.com/api';

const SHEET_ORGS                 = 'Organizations';
const SHEET_TMPL_SSID            = 'Template_SSID';
const SHEET_TMPL_FW              = 'Template_Firewall';
const SHEET_DIFF_REPORT          = 'Diff_Report';
const SHEET_BACKUP_SSID          = 'Backup_SSID';
const SHEET_BACKUP_FW            = 'Backup_Firewall';
const SHEET_COMP_REPORT          = 'Comparison_Report';
const SHEET_LOG_MULTI            = 'Log_MultiOrg';
const SHEET_NETWORK_PROVISIONING = 'Network_Provisioning';

// ============================================================
// 共通関数
// ============================================================
function showConfirmDialog(title, message) {
  const ui      = SpreadsheetApp.getUi();
  const confirm = ui.alert(title, message, ui.ButtonSet.YES_NO);
  return confirm === ui.Button.YES;
}

function getRequiredSheet(sheetName) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(
      '❌ シートが見つかりません。\n' +
      '「' + sheetName + '」という名前のシートを確認してください。'
    );
  }
  return sheet;
}

function getConfig() {
  const sheet  = getRequiredSheet(SHEET_CONFIG);
  const data   = sheet.getDataRange().getValues();
  const config = {};
  data.forEach(row => {
    if (row[0]) config[row[0]] = row[1];
  });
  return config;
}

function merakiFetch(method, endpoint, payload, apiKey) {
  const url     = String(endpoint).indexOf('https://') === 0
    ? String(endpoint)
    : BASE_URL + endpoint;
  const options = {
    method             : method,
    headers            : {
      'X-Cisco-Meraki-API-Key' : apiKey,
      'Content-Type'           : 'application/json'
    },
    muteHttpExceptions : true
  };

  if (payload) {
    options.payload = JSON.stringify(payload);
  }

  const response = UrlFetchApp.fetch(url, options);
  return {
    code    : response.getResponseCode(),
    body    : response.getContentText(),
    headers : response.getAllHeaders()
  };
}

function merakiRequest(method, endpoint, payload, apiKey) {
  const result = merakiFetch(method, endpoint, payload, apiKey);
  Logger.log('[' + method + '] ' + endpoint + ' → HTTP ' + result.code);

  if (result.code >= 200 && result.code < 300) {
    return result.body ? JSON.parse(result.body) : {};
  }

  Logger.log('Error Response: ' + result.body);
  throw new Error('API Error ' + result.code + ': ' + result.body);
}

function headerValue(headers, name) {
  if (!headers) return '';
  const direct = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  if (direct) return Array.isArray(direct) ? direct.join(',') : String(direct);
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === name.toLowerCase()) {
      const value = headers[keys[i]];
      return Array.isArray(value) ? value.join(',') : String(value);
    }
  }
  return '';
}

function nextPageEndpoint(headers) {
  const linkText = headerValue(headers, 'Link');
  const match = linkText.match(/<([^>]+)>;\s*rel="?next"?/i);
  if (!match) return null;

  const url = match[1];
  const marker = '/api';
  const idx = url.indexOf(marker);
  if (idx >= 0) return url.substring(idx + marker.length);
  if (url.indexOf('/v1/') === 0) return url;
  return null;
}

function hasProductType(network, productType) {
  const types = network && network.productTypes;
  return Array.isArray(types) && types.indexOf(productType) !== -1;
}

function isActiveFlag(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}

// ============================================================
// ユーティリティ：policy / protocol / port
// ============================================================
function normalizeFWPolicy(value) {
  if (!value || value === '') return 'deny';
  const normalized = String(value).trim().toLowerCase();
  switch (normalized) {
    case 'allow': case '許可': case 'permit': case 'yes':
      return 'allow';
    case 'deny': case '拒否': case 'block': case 'no':
      return 'deny';
    default:
      Logger.log('⚠️ 不明なpolicy値: "' + value + '" → "deny" に変換');
      return 'deny';
  }
}

function normalizeFWProtocol(value) {
  if (!value || value === '') return 'any';
  const normalized = String(value).trim().toLowerCase();
  switch (normalized) {
    case 'tcp':  return 'tcp';
    case 'udp':  return 'udp';
    case 'icmp': return 'icmp';
    case 'any':  return 'any';
    default:
      Logger.log('⚠️ 不明なprotocol値: "' + value + '" → "any" に変換');
      return 'any';
  }
}

function normalizeFWPort(value) {
  if (value === '' || value === null || value === undefined) return 'Any';
  const str = String(value).trim();
  return (str === '' || str.toLowerCase() === 'any') ? 'Any' : str;
}

function sanitizeVlanTagging(payload, ipAssignmentMode) {
  const mode = String(ipAssignmentMode).trim().toLowerCase();
  const supportsVlan = mode.indexOf('bridge') !== -1 || mode.indexOf('layer 3') !== -1;
  if (!supportsVlan && payload.useVlanTagging === true) {
    Logger.log('⚠️ NAT modeのためVLANタギングを無効化: ' + payload.name);
    payload.useVlanTagging = false;
    delete payload.defaultVlanId;
  }
  return payload;
}

function expectedVlanTagging(vlanId, ipMode) {
  const requested = vlanId !== '' && vlanId !== null && vlanId !== undefined;
  const mode = String(ipMode || 'Bridge mode').trim().toLowerCase();
  const supportsVlan = mode.indexOf('bridge') !== -1 || mode.indexOf('layer 3') !== -1;
  return requested && supportsVlan;
}

function canonicalAuthModeLabel(value) {
  const str = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  switch (str) {
    case 'open':
      return 'open';
    case 'wpa2 personal':
    case 'wpa2personal':
    case 'psk':
      return 'WPA2 Personal';
    case 'wpa3 personal':
    case 'wpa3personal':
      return 'WPA3 Personal';
    case 'wpa2 enterprise':
    case '8021x-radius':
      return 'WPA2 Enterprise';
    case 'wpa3 enterprise':
    case 'wpa3enterprise':
      return 'WPA3 Enterprise';
    default:
      return String(value || '').trim();
  }
}

function normalizeAuthMode(value) {
  const label = canonicalAuthModeLabel(value);
  switch (label) {
    case 'open':
      return 'open';
    case 'WPA2 Personal':
    case 'WPA3 Personal':
      return 'psk';
    case 'WPA2 Enterprise':
    case 'WPA3 Enterprise':
      return '8021x-radius';
    default:
      return String(value || '').trim().toLowerCase();
  }
}

function expectedWpaEncryptionMode(value) {
  switch (canonicalAuthModeLabel(value)) {
    case 'WPA2 Personal':
    case 'WPA2 Enterprise':
      return 'WPA2 only';
    case 'WPA3 Personal':
    case 'WPA3 Enterprise':
      return 'WPA3 Transition Mode';
    default:
      return '';
  }
}

function isDryRunEnabled() {
  const cfg = getConfig();
  return String(cfg['DRY_RUN']).trim().toUpperCase() === 'TRUE';
}

function merakiRequestSafe(method, path, payload, apiKey, description) {
  const mutating = ['POST', 'PUT', 'DELETE'].indexOf(String(method).toUpperCase()) !== -1;

  if (isDryRunEnabled() && mutating) {
    Logger.log('🧪 [DRY RUN] ' + method + ' ' + path + '\n' + (description || ''));
    return { dryRun: true };
  }
  return merakiRequest(method, path, payload, apiKey);
}

function isApprovalRequired() {
  const cfg = getConfig();
  return String(cfg['APPROVAL_REQUIRED']).trim().toUpperCase() === 'TRUE';
}

function promptForApprover(actionLabel) {
  if (!isApprovalRequired()) {
    return Session.getActiveUser().getEmail();
  }
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(
    '承認者確認',
    '「' + actionLabel + '」を実行するには承認者名の入力が必要です。\n\n承認者名を入力してください:',
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() !== ui.Button.OK) return null;
  const name = result.getResponseText().trim();
  return name === '' ? null : name;
}

function buildRadiusServer(radiusIp, radiusPort, radiusSecret) {
  if (!radiusIp || radiusIp === '') return null;
  const server = {
    host : radiusIp,
    port : Number(radiusPort) || 1812
  };
  if (radiusSecret && radiusSecret !== '') {
    server.secret = radiusSecret;
  }
  return server;
}

function buildSSIDPayloadFromTemplateRow(row) {
  const ssidNumber    = row[0];
  const ssidName      = row[1];
  const enabled       = row[2];
  const authMode      = canonicalAuthModeLabel(row[3]);
  const psk           = row[4];
  const radiusIp      = row[5];
  const radiusPort    = row[6];
  const radiusSecret  = row[7];
  const vlanId        = row[8];
  const bandwidthKbps = row[9];
  const ipMode        = row[11];

  if (ssidNumber === '' || ssidNumber === null) return null;

  const payload = {
    name    : ssidName,
    enabled : isActiveFlag(enabled)
  };

  switch (authMode) {
    case 'open':
      payload.authMode = 'open';
      break;
    case 'WPA2 Personal':
      payload.authMode          = 'psk';
      payload.encryptionMode    = 'wpa';
      payload.wpaEncryptionMode = 'WPA2 only';
      payload.psk               = psk;
      break;
    case 'WPA3 Personal':
      payload.authMode          = 'psk';
      payload.encryptionMode    = 'wpa';
      payload.wpaEncryptionMode = 'WPA3 Transition Mode';
      payload.psk               = psk;
      break;
    case 'WPA2 Enterprise':
    case 'WPA3 Enterprise':
      payload.authMode          = '8021x-radius';
      payload.encryptionMode    = 'wpa';
      payload.wpaEncryptionMode = authMode === 'WPA3 Enterprise'
        ? 'WPA3 Transition Mode'
        : 'WPA2 only';
      if (radiusIp && radiusIp !== '') {
        const server = buildRadiusServer(radiusIp, radiusPort, radiusSecret);
        if (server) payload.radiusServers = [server];
      }
      break;
    default:
      if (authMode) {
        Logger.log('⚠️ 未対応のAuth Mode: "' + row[3] + '"');
        payload.authMode = normalizeAuthMode(row[3]);
      }
  }

  if (vlanId !== '' && vlanId !== null && vlanId !== undefined) {
    payload.useVlanTagging = true;
    payload.defaultVlanId  = Number(vlanId);
  } else {
    payload.useVlanTagging = false;
  }

  if (bandwidthKbps !== '' && bandwidthKbps !== null && bandwidthKbps !== undefined) {
    payload.perClientBandwidthLimitUp   = Number(bandwidthKbps);
    payload.perClientBandwidthLimitDown = Number(bandwidthKbps);
  }

  payload.ipAssignmentMode = (ipMode !== '' && ipMode !== null) ? ipMode : 'Bridge mode';
  sanitizeVlanTagging(payload, payload.ipAssignmentMode);

  return { ssidNumber: ssidNumber, payload: payload };
}

function buildFirewallRulesFromTemplate() {
  const tmplSheet = getRequiredSheet(SHEET_TMPL_FW);
  const tmplRows  = tmplSheet.getDataRange().getValues();
  const rules     = [];

  for (let i = 1; i < tmplRows.length; i++) {
    const row = tmplRows[i];
    if (row[0] === '' || row[0] === null) continue;
    rules.push({
      policy   : normalizeFWPolicy(row[0]),
      protocol : normalizeFWProtocol(row[1]),
      srcCidr  : (row[2] && row[2] !== '') ? row[2] : 'Any',
      destCidr : (row[3] && row[3] !== '') ? row[3] : 'Any',
      srcPort  : normalizeFWPort(row[4]),
      destPort : normalizeFWPort(row[5]),
      comment  : row[6] || ''
    });
  }
  return rules;
}

function previewSSIDChanges(orgs) {
  const tmplSheet = getRequiredSheet(SHEET_TMPL_SSID);
  const tmplRows  = tmplSheet.getDataRange().getValues();
  const changes   = [];

  orgs.forEach(org => {
    try {
      const networks = getNetworks(org.orgId, org.apiKey);
      networks.forEach(network => {
        if (!hasProductType(network, 'wireless')) return;

        for (let i = 1; i < tmplRows.length; i++) {
          const built = buildSSIDPayloadFromTemplateRow(tmplRows[i]);
          if (!built) continue;

          try {
            const current = merakiRequest(
              'GET',
              '/v1/networks/' + network.id + '/wireless/ssids/' + built.ssidNumber,
              null, org.apiKey
            );
            const isDiff = current.name !== built.payload.name ||
                           current.authMode !== built.payload.authMode ||
                           !!current.useVlanTagging !== !!built.payload.useVlanTagging;
            if (isDiff) {
              changes.push(
                org.name + ' / ' + network.name + ' / SSID' + built.ssidNumber + ': ' +
                '"' + current.name + '"(' + current.authMode + ') → "' +
                built.payload.name + '"(' + built.payload.authMode + ')'
              );
            }
          } catch (e) { /* プレビュー取得失敗は無視して続行 */ }
        }
      });
    } catch (e) { /* Org取得失敗は無視して続行 */ }
  });

  return changes;
}

function previewFirewallChanges(orgs) {
  const rules = buildFirewallRulesFromTemplate();
  let affectedNetworks = 0;
  orgs.forEach(org => {
    try {
      const networks = getNetworks(org.orgId, org.apiKey);
      affectedNetworks += networks.filter(function (n) {
        return hasProductType(n, 'appliance');
      }).length;
    } catch (e) { /* 無視 */ }
  });
  return { ruleCount: rules.length, affectedNetworks: affectedNetworks };
}

function applyFirewallToSingleNetwork(networkId, networkName, orgName, apiKey) {
  const rules = buildFirewallRulesFromTemplate();
  try {
    const result = merakiRequestSafe(
      'PUT',
      '/v1/networks/' + networkId + '/appliance/firewall/l3FirewallRules',
      { rules: rules }, apiKey,
      'Firewallルール ' + rules.length + '件'
    );
    const label = result.dryRun ? '🧪 DRY RUN' : '✅ 成功';
    writeMultiOrgLog(orgName, 'FWルール反映(単体)', networkName, label);
    return { successCount: 1, errorCount: 0 };
  } catch (e) {
    writeMultiOrgLog(orgName, 'FWルール反映(単体)', networkName, '❌ エラー: ' + e.message);
    return { successCount: 0, errorCount: 1 };
  }
}

function sendWebexNotification(message) {
  const cfg    = getConfig();
  const token  = cfg['WEBEX_BOT_TOKEN'];
  const roomId = cfg['WEBEX_ROOM_ID'];

  if (!token || !roomId) {
    Logger.log('⚠️ Webex設定が未完了です（WEBEX_BOT_TOKEN / WEBEX_ROOM_ID）');
    return;
  }

  const options = {
    method             : 'POST',
    headers            : {
      'Authorization' : 'Bearer ' + token,
      'Content-Type'  : 'application/json'
    },
    payload            : JSON.stringify({ roomId: roomId, markdown: message }),
    muteHttpExceptions : true
  };

  try {
    const response = UrlFetchApp.fetch('https://webexapis.com/v1/messages', options);
    const code = response.getResponseCode();
    if (code === 200) {
      Logger.log('✅ Webex通知送信成功');
    } else {
      Logger.log('❌ Webex通知エラー: ' + response.getContentText());
    }
  } catch (e) {
    Logger.log('❌ Webex通知例外: ' + e.message);
  }
}

function getOrganizations() {
  const sheet = getRequiredSheet(SHEET_ORGS);
  const rows  = sheet.getDataRange().getValues();
  const orgs  = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (isActiveFlag(row[3])) {
      orgs.push({
        name     : row[0],
        orgId    : String(row[1]),
        apiKey   : row[2],
        rowIndex : i + 1
      });
    }
  }
  return orgs;
}

function getNetworks(orgId, apiKey) {
  const all = [];
  let endpoint = '/v1/organizations/' + encodeURIComponent(orgId) + '/networks?perPage=1000';
  const seen = {};
  let pages = 0;

  while (endpoint && pages < 100) {
    if (seen[endpoint]) break;
    seen[endpoint] = true;
    pages++;

    const result = merakiFetch('GET', endpoint, null, apiKey);
    Logger.log('[GET] ' + endpoint + ' → HTTP ' + result.code);
    if (result.code < 200 || result.code >= 300) {
      Logger.log('Error Response: ' + result.body);
      throw new Error('API Error ' + result.code + ': ' + result.body);
    }

    const page = result.body ? JSON.parse(result.body) : [];
    if (Array.isArray(page)) {
      for (let i = 0; i < page.length; i++) all.push(page[i]);
    }

    endpoint = nextPageEndpoint(result.headers);
    if (endpoint) Utilities.sleep(200);
  }
  return all;
}

function ensureMultiOrgLogHeader() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_LOG_MULTI);

  if (!sheet) sheet = ss.insertSheet(SHEET_LOG_MULTI);

  const firstCell = sheet.getRange(1, 1).getValue();
  if (firstCell === '' || firstCell === null) {
    sheet.getRange(1, 1, 1, 7).setValues([[
      '実行日時', '実行者', 'Org名', '実行内容', '対象', '結果', '承認者'
    ]]);
    sheet.getRange(1, 1, 1, 7)
      .setBackground('#4A86E8').setFontColor('#FFFFFF').setFontWeight('bold');
    return sheet;
  }

  const lastCol   = sheet.getLastColumn();
  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headerRow.indexOf('承認者') === -1) {
    sheet.insertColumnAfter(lastCol);
    sheet.getRange(1, lastCol + 1).setValue('承認者')
      .setBackground('#4A86E8').setFontColor('#FFFFFF').setFontWeight('bold');
  }
  return sheet;
}

function writeMultiOrgLog(orgName, action, target, status, approver) {
  const sheet = ensureMultiOrgLogHeader();
  sheet.appendRow([
    new Date(),
    Session.getActiveUser().getEmail(),
    orgName, action, target, status,
    approver || ''
  ]);
}

function ensureDiffReportHeader() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_DIFF_REPORT);

  if (!sheet) sheet = ss.insertSheet(SHEET_DIFF_REPORT);

  const firstCell = sheet.getRange(1, 1).getValue();
  if (firstCell === '' || firstCell === null) {
    sheet.getRange(1, 1, 1, 9).setValues([[
      'チェック日時', 'Org名', 'Network名',
      '設定項目', '期待値', '実際の値', '結果',
      'ステータス', '最終更新日時'
    ]]);
    sheet.getRange(1, 1, 1, 9)
      .setBackground('#E06666')
      .setFontColor('#FFFFFF')
      .setFontWeight('bold');
  }
  return sheet;
}

function writeDiffReport(orgName, networkName, item, expected, actual, result, status) {
  const sheet     = ensureDiffReportHeader();
  const timestamp = Utilities.formatDate(
    new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'
  );
  sheet.appendRow([
    new Date(), orgName, networkName,
    item, expected, actual, result,
    status || result, timestamp
  ]);
}

function initComparisonReport(orgs, items) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_COMP_REPORT);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_COMP_REPORT);
  } else {
    sheet.clearContents();
  }

  const headers = ['設定項目', '基準値 (Template)'].concat(
    orgs.map(function (o) { return o.name; }),
    ['総合判定']
  );

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#4A86E8')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');

  const dataRows = items.map(function (item) {
    const orgValues = orgs.map(function (o) {
      return item.orgValues[o.name] || '未取得';
    });
    const allMatch = orgValues.every(function (v) {
      return String(v) === String(item.templateValue);
    });
    return [
      item.label,
      item.templateValue
    ].concat(orgValues, [allMatch ? '✅ 全一致' : '⚠️ 不一致あり']);
  });

  if (dataRows.length > 0) {
    sheet.getRange(2, 1, dataRows.length, headers.length).setValues(dataRows);
    dataRows.forEach(function (row, idx) {
      if (row[row.length - 1] !== '✅ 全一致') {
        sheet.getRange(idx + 2, 1, 1, headers.length).setBackground('#FCE8E6');
      }
    });
  }

  sheet.autoResizeColumns(1, headers.length);
  return sheet;
}

function ensureStatusColumns(sheet, headerColor) {
  const lastCol   = sheet.getLastColumn();
  const headerRow = sheet.getRange(1, 1, 1, Math.max(lastCol, 1)).getValues()[0];

  let statusCol  = headerRow.indexOf('ステータス') + 1;
  let updatedCol = headerRow.indexOf('最終更新日時') + 1;

  if (statusCol === 0) {
    statusCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, statusCol).setValue('ステータス')
      .setBackground(headerColor)
      .setFontColor('#FFFFFF')
      .setFontWeight('bold');
  }
  if (updatedCol === 0) {
    updatedCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, updatedCol).setValue('最終更新日時')
      .setBackground(headerColor)
      .setFontColor('#FFFFFF')
      .setFontWeight('bold');
  }
  return { statusCol: statusCol, updatedCol: updatedCol };
}

function updateTemplateSSIDStatus(sheet, rowIndex, status) {
  const cols = ensureStatusColumns(sheet, '#4A86E8');
  sheet.getRange(rowIndex, cols.statusCol).setValue(status);
  sheet.getRange(rowIndex, cols.updatedCol).setValue(
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss')
  );
}

function updateTemplateFWStatus(sheet, rowIndex, status) {
  const cols = ensureStatusColumns(sheet, '#E06666');
  sheet.getRange(rowIndex, cols.statusCol).setValue(status);
  sheet.getRange(rowIndex, cols.updatedCol).setValue(
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss')
  );
}

function updateDiffReportStatus(sheet, rowIndex, status) {
  const cols = ensureStatusColumns(sheet, '#E06666');
  sheet.getRange(rowIndex, cols.statusCol).setValue(status);
  sheet.getRange(rowIndex, cols.updatedCol).setValue(
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss')
  );
}

function ensureBackupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let ssidSheet = ss.getSheetByName(SHEET_BACKUP_SSID);
  if (!ssidSheet) ssidSheet = ss.insertSheet(SHEET_BACKUP_SSID);

  if (ssidSheet.getRange(1, 1).getValue() === '') {
    ssidSheet.getRange(1, 1, 1, 15).setValues([[
      'バックアップ日時', 'Org名', 'Org ID',
      'Network名', 'Network ID',
      'SSID番号', 'SSID名', '有効/無効',
      '認証モード', 'PSK', 'VLANタギング', 'IPモード',
      'RADIUS IP', 'RADIUSポート', 'RADIUSシークレット'
    ]]);
    ssidSheet.getRange(1, 1, 1, 15)
      .setBackground('#34A853')
      .setFontColor('#FFFFFF')
      .setFontWeight('bold');
  }

  let fwSheet = ss.getSheetByName(SHEET_BACKUP_FW);
  if (!fwSheet) fwSheet = ss.insertSheet(SHEET_BACKUP_FW);

  if (fwSheet.getRange(1, 1).getValue() === '') {
    fwSheet.getRange(1, 1, 1, 11).setValues([[
      'バックアップ日時', 'Org名', 'Org ID',
      'Network名', 'Network ID',
      'ポリシー', 'プロトコル',
      '送信元CIDR', '宛先CIDR',
      '送信元ポート', '宛先ポート'
    ]]);
    fwSheet.getRange(1, 1, 1, 11)
      .setBackground('#EA4335')
      .setFontColor('#FFFFFF')
      .setFontWeight('bold');
  }

  return { ssidSheet: ssidSheet, fwSheet: fwSheet };
}

function _getApiKeyByOrgId(orgId) {
  const sheet = getRequiredSheet(SHEET_ORGS);
  const rows  = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === String(orgId)) return rows[i][2];
  }
  return null;
}

function _getOrgInfoByOrgId(orgId) {
  const sheet = getRequiredSheet(SHEET_ORGS);
  const rows  = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === String(orgId)) {
      return { name: rows[i][0], apiKey: rows[i][2] };
    }
  }
  return null;
}

function ensureNetworkProvisioningHeader() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NETWORK_PROVISIONING);

  if (!sheet) sheet = ss.insertSheet(SHEET_NETWORK_PROVISIONING);

  const firstCell = sheet.getRange(1, 1).getValue();
  if (firstCell === '' || firstCell === null) {
    sheet.getRange(1, 1, 1, 7).setValues([[
      'OrgId', 'NetworkName', 'ProductTypes(カンマ区切り)',
      'TimeZone', 'Tags(カンマ区切り)', '承認者', 'ステータス'
    ]]);
    sheet.getRange(1, 1, 1, 7)
      .setBackground('#6AA84F').setFontColor('#FFFFFF').setFontWeight('bold');
    return sheet;
  }

  const lastCol   = sheet.getLastColumn();
  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headerRow.indexOf('承認者') === -1) {
    const statusIdx = headerRow.indexOf('ステータス');
    const insertPos = statusIdx >= 0 ? statusIdx + 1 : lastCol + 1;
    sheet.insertColumnBefore(insertPos);
    sheet.getRange(1, insertPos).setValue('承認者')
      .setBackground('#6AA84F').setFontColor('#FFFFFF').setFontWeight('bold');
  }
  return sheet;
}

function updateNetworkProvisioningStatus(sheet, rowIndex, status) {
  const cols = ensureStatusColumns(sheet, '#6AA84F');
  sheet.getRange(rowIndex, cols.statusCol).setValue(status);
  sheet.getRange(rowIndex, cols.updatedCol).setValue(
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss')
  );
}

function isNetworkNameDuplicate(orgId, networkName, apiKey) {
  const networks = getNetworks(orgId, apiKey);
  return networks.some(function (n) { return n.name === networkName; });
}

function createNetworkFromGolden(orgId, networkName, productTypes, timeZone, tags, apiKey) {
  const cfg = getConfig();
  const goldenNetworkId = String(cfg['GOLDEN_NETWORK_ID'] || '').trim();

  const payload = {
    name         : networkName,
    productTypes : productTypes,
    timeZone     : timeZone || 'Asia/Tokyo',
    tags         : tags || []
  };
  if (goldenNetworkId) payload.copyFromNetworkId = goldenNetworkId;

  if (isDryRunEnabled()) {
    Logger.log(
      '🧪 [DRY RUN] Network作成予定: ' + networkName +
      ' (Org: ' + orgId + ') ← Golden: ' + (goldenNetworkId || 'なし')
    );
    return { id: 'DRYRUN-' + new Date().getTime(), name: networkName, dryRun: true };
  }

  const result = merakiRequest(
    'POST', '/v1/organizations/' + orgId + '/networks', payload, apiKey
  );
  Logger.log(
    '✅ Network作成成功: ' + result.name + ' (ID: ' + result.id +
    ') ← Golden: ' + (goldenNetworkId || 'なし')
  );
  return result;
}

function applySSIDToSingleNetwork(networkId, networkName, orgName, apiKey) {
  const tmplSheet = getRequiredSheet(SHEET_TMPL_SSID);
  const tmplRows  = tmplSheet.getDataRange().getValues();
  let successCount = 0;
  let errorCount   = 0;

  for (let i = 1; i < tmplRows.length; i++) {
    const built = buildSSIDPayloadFromTemplateRow(tmplRows[i]);
    if (!built) continue;

    try {
      const result = merakiRequestSafe(
        'PUT',
        '/v1/networks/' + networkId + '/wireless/ssids/' + built.ssidNumber,
        built.payload, apiKey,
        'SSID' + built.ssidNumber + ' → ' + built.payload.name
      );
      const label = result.dryRun ? '🧪 DRY RUN' : '✅ 成功';
      writeMultiOrgLog(
        orgName, 'SSID設定反映(単体)',
        networkName + ' - SSID ' + built.ssidNumber, label
      );
      successCount++;
    } catch (e) {
      writeMultiOrgLog(
        orgName, 'SSID設定反映(単体)',
        networkName + ' - SSID ' + built.ssidNumber, '❌ エラー: ' + e.message
      );
      errorCount++;
    }
    Utilities.sleep(300);
  }
  return { successCount: successCount, errorCount: errorCount };
}

function provisionNetworksFromSheet() {
  const sheet   = ensureNetworkProvisioningHeader();
  const rows    = sheet.getDataRange().getValues();
  const ui      = SpreadsheetApp.getUi();
  const headers = rows[0];

  const colOrgId       = headers.indexOf('OrgId');
  const colNetworkName = headers.indexOf('NetworkName');
  const colProductType = headers.indexOf('ProductTypes(カンマ区切り)');
  const colTimeZone    = headers.indexOf('TimeZone');
  const colTags        = headers.indexOf('Tags(カンマ区切り)');
  const colApprover    = headers.indexOf('承認者');

  const targetRows = rows.filter(function (row, idx) {
    return idx > 0 && row[colOrgId] && row[colNetworkName];
  });
  const previewCount = targetRows.length;

  if (previewCount === 0) {
    ui.alert('❌ 作成対象の行が見つかりません。Network_Provisioningシートを確認してください。');
    return;
  }

  let missingApproverRows = [];
  if (isApprovalRequired()) {
    missingApproverRows = targetRows.filter(function (row) {
      const approver = colApprover >= 0 ? row[colApprover] : '';
      return !approver || String(approver).trim() === '';
    });
  }

  const willProcessCount = previewCount - missingApproverRows.length;
  let confirmMessage = 'Network_Provisioningシートの内容に従い、' + previewCount + '件の新規Networkを作成します。\n\n';

  if (isApprovalRequired() && missingApproverRows.length > 0) {
    const missingNames = missingApproverRows
      .map(function (row) { return row[colNetworkName]; })
      .slice(0, 10)
      .join('\n- ');
    confirmMessage +=
      '⚠️ 以下の' + missingApproverRows.length + '件は「承認者」列が未入力のため、実行時にスキップされます:\n\n- ' +
      missingNames +
      (missingApproverRows.length > 10 ? '\n...他 ' + (missingApproverRows.length - 10) + ' 件' : '') +
      '\n\n実際に作成される件数: ' + willProcessCount + '件\n\n';
  }

  confirmMessage += isDryRunEnabled() ? '🧪 現在ドライランモードです（実際の変更は行われません）\n\n' : '';
  confirmMessage += 'よろしいですか？';

  if (!showConfirmDialog('🏗 Network作成確認', confirmMessage)) {
    ui.alert('❌ キャンセルしました。');
    return;
  }

  const cfg = getConfig();
  const goldenNetworkId = String(cfg['GOLDEN_NETWORK_ID'] || '').trim();
  if (!goldenNetworkId) {
    Logger.log('⚠️ GOLDEN_NETWORK_IDが未設定です。コピー元なしで新規作成します。');
  }

  let successCount = 0;
  let errorCount = 0;
  const errorDetails = [];
  const createdList = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const orgId = row[colOrgId];
    const networkName = row[colNetworkName];
    if (!orgId || !networkName) continue;

    const productTypes = String(row[colProductType] || 'appliance,switch,wireless')
      .split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
    const timeZone = row[colTimeZone] || 'Asia/Tokyo';
    const tags = row[colTags]
      ? String(row[colTags]).split(',').map(function (s) { return s.trim(); })
      : [];
    const approver = colApprover >= 0 ? row[colApprover] : '';

    if (isApprovalRequired() && (!approver || String(approver).trim() === '')) {
      updateNetworkProvisioningStatus(sheet, i + 1, '⚠️ 承認者未入力のためスキップ');
      errorCount++;
      errorDetails.push('- ' + networkName + ': 承認者が未入力のためスキップされました');
      continue;
    }

    const orgInfo = _getOrgInfoByOrgId(String(orgId));
    if (!orgInfo) {
      updateNetworkProvisioningStatus(sheet, i + 1, '❌ Org情報が見つかりません');
      writeMultiOrgLog(
        '(不明: OrgId ' + orgId + ')', 'Network作成(Golden)', networkName,
        '❌ エラー: 該当するOrganizationが見つかりません', approver
      );
      errorCount++;
      errorDetails.push('- OrgId ' + orgId + ' / ' + networkName + ': Organizationsシートに該当Orgがありません');
      continue;
    }

    try {
      if (isNetworkNameDuplicate(orgId, networkName, orgInfo.apiKey)) {
        updateNetworkProvisioningStatus(sheet, i + 1, '⚠️ 同名Networkが既に存在します');
        writeMultiOrgLog(orgInfo.name, 'Network作成(Golden)', networkName, '⚠️ スキップ(重複)', approver);
        errorCount++;
        errorDetails.push('- **' + orgInfo.name + '** / ' + networkName + ': 同名Networkが既に存在するためスキップ');
        continue;
      }
    } catch (e) {
      Logger.log('⚠️ 重複チェック中にエラー（続行します）: ' + e.message);
    }

    try {
      const created = createNetworkFromGolden(
        orgId, networkName, productTypes, timeZone, tags, orgInfo.apiKey
      );
      const label = created.dryRun
        ? '🧪 [DRY RUN] 作成予定 (仮ID: ' + created.id + ')'
        : '✅ 作成済み (ID: ' + created.id + ')';
      updateNetworkProvisioningStatus(sheet, i + 1, label);
      writeMultiOrgLog(
        orgInfo.name, 'Network作成(Golden)', networkName,
        created.dryRun ? '🧪 DRY RUN' : '✅ 成功', approver
      );

      const ssidResult = applySSIDToSingleNetwork(
        created.id, created.name, orgInfo.name, orgInfo.apiKey
      );
      if (ssidResult.errorCount > 0) {
        errorDetails.push(
          '- **' + orgInfo.name + '** / ' + created.name +
          ': SSID一部反映失敗(' + ssidResult.errorCount + '件)'
        );
      }

      if (productTypes.indexOf('appliance') !== -1) {
        const fwResult = applyFirewallToSingleNetwork(
          created.id, created.name, orgInfo.name, orgInfo.apiKey
        );
        if (fwResult.errorCount > 0) {
          errorDetails.push('- **' + orgInfo.name + '** / ' + created.name + ': Firewall反映失敗');
        }
      }

      createdList.push({
        orgName: orgInfo.name,
        networkName: created.name,
        networkId: created.id
      });
      successCount++;
    } catch (e) {
      updateNetworkProvisioningStatus(sheet, i + 1, '❌ エラー: ' + e.message);
      writeMultiOrgLog(
        orgInfo.name, 'Network作成(Golden)', networkName,
        '❌ エラー: ' + e.message, approver
      );
      errorCount++;
      errorDetails.push('- **' + orgInfo.name + '** / ' + networkName + ': ' + e.message);
    }
    Utilities.sleep(300);
  }

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  let webexMsg = '## 🏗 Network新規作成(Golden Network方式) 完了通知' +
    (isDryRunEnabled() ? '（🧪 DRY RUN）' : '') + '\n\n';
  webexMsg += '**実行日時:** ' + ts + '\n\n**Golden Network ID:** ' +
    (goldenNetworkId || '(未設定)') + '\n\n';
  webexMsg += '**結果:** 成功 ' + successCount + '件 / エラー ' + errorCount + '件\n\n';
  if (createdList.length > 0) {
    webexMsg += '**作成対象Network:**\n' + createdList.map(function (c) {
      return '- ' + c.orgName + ' / ' + c.networkName + ' (ID: ' + c.networkId + ')';
    }).join('\n') + '\n\n';
  }
  webexMsg += errorCount === 0
    ? '✅ **全てのNetwork作成が正常に完了しました。**'
    : '⚠️ **一部エラーが発生しました。**\n\n**エラー詳細:**\n' + errorDetails.join('\n');

  sendWebexNotification(webexMsg);
  ui.alert('🏗 Network作成処理が完了しました！\n\n成功: ' + successCount + '件 / エラー: ' + errorCount + '件');
}

function applySSIDToAllOrgs() {
  const orgs = getOrganizations();
  const ui = SpreadsheetApp.getUi();
  if (orgs.length === 0) {
    ui.alert(
      '❌ 対象のOrganizationが見つかりません。\n' +
      'OrganizationsシートのD列（Active）をTRUEに設定してください。'
    );
    return;
  }

  SpreadsheetApp.getActiveSpreadsheet().toast(
    '変更内容を確認しています。完了までこのままお待ちください。',
    '🔍 SSIDプレビュー',
    30
  );
  const changes = previewSSIDChanges(orgs);
  const previewText = changes.length > 0
    ? '以下の変更が予定されています（最大10件表示）:\n\n' + changes.slice(0, 10).join('\n') +
      (changes.length > 10 ? '\n...他 ' + (changes.length - 10) + ' 件' : '')
    : '現状との差分は検出されませんでした。';

  const approver = promptForApprover('全OrgへのSSID設定反映');
  if (approver === null) {
    ui.alert('❌ 承認者が入力されなかったため、処理を中止しました。');
    return;
  }

  if (!showConfirmDialog(
    '⚠️ 確認',
    '全Organization（Active = TRUE）に\nSSID設定を一括反映します。\n\n' + previewText + '\n\n' +
    (isDryRunEnabled() ? '🧪 現在ドライランモードです（実際の変更は行われません）\n\n' : '') +
    'よろしいですか？'
  )) {
    ui.alert('❌ キャンセルしました。');
    return;
  }

  const tmplSheet = getRequiredSheet(SHEET_TMPL_SSID);
  const tmplRows = tmplSheet.getDataRange().getValues();
  let successCount = 0;
  let errorCount = 0;
  const errorDetails = [];

  orgs.forEach(function (org) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      org.name + ' にSSID設定を反映しています',
      '📶 SSID反映',
      5
    );
    Logger.log('\n===== ' + org.name + ' (' + org.orgId + ') 開始 =====');

    try {
      const networks = getNetworks(org.orgId, org.apiKey);
      networks.forEach(function (network) {
        if (!hasProductType(network, 'wireless')) return;

        for (let i = 1; i < tmplRows.length; i++) {
          const built = buildSSIDPayloadFromTemplateRow(tmplRows[i]);
          if (!built) continue;

          try {
            const result = merakiRequestSafe(
              'PUT',
              '/v1/networks/' + network.id + '/wireless/ssids/' + built.ssidNumber,
              built.payload, org.apiKey,
              'SSID' + built.ssidNumber + ' → ' + built.payload.name
            );
            const label = result.dryRun ? '🧪 [DRY RUN] 反映予定' : '✅ 反映済み';
            updateTemplateSSIDStatus(
              tmplSheet, i + 1, label + ' (' + org.name + ' / ' + network.name + ')'
            );
            writeMultiOrgLog(
              org.name, 'SSID設定反映',
              network.name + ' - SSID ' + built.ssidNumber,
              result.dryRun ? '🧪 DRY RUN' : '✅ 成功', approver
            );
            successCount++;
          } catch (e) {
            updateTemplateSSIDStatus(tmplSheet, i + 1, '❌ エラー: ' + e.message);
            writeMultiOrgLog(
              org.name, 'SSID設定反映',
              network.name + ' - SSID ' + built.ssidNumber,
              '❌ エラー: ' + e.message, approver
            );
            errorCount++;
            errorDetails.push(
              '- **' + org.name + '** / ' + network.name + ' / SSID ' +
              built.ssidNumber + ': ' + e.message
            );
          }
          Utilities.sleep(300);
        }
      });
    } catch (e) {
      writeMultiOrgLog(org.name, 'SSID設定反映', org.orgId, '❌ エラー: ' + e.message, approver);
      errorCount++;
      errorDetails.push('- **' + org.name + '**: ' + e.message);
    }
  });

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  let webexMsg = '## 📶 SSID一括設定 完了通知' +
    (isDryRunEnabled() ? '（🧪 DRY RUN）' : '') + '\n\n';
  webexMsg += '**実行日時:** ' + ts + '\n**承認者:** ' + approver + '\n\n';
  webexMsg += '**結果:** 成功 ' + successCount + '件 / エラー ' + errorCount + '件\n\n';
  webexMsg += errorCount === 0
    ? '✅ **全Organizationへの設定反映が正常に完了しました。**'
    : '⚠️ **一部エラーが発生しました。**\n\n**エラー詳細:**\n' + errorDetails.join('\n');

  sendWebexNotification(webexMsg);
  ui.alert('🎉 SSID設定反映が完了しました！\n\n成功: ' + successCount + '件 / エラー: ' + errorCount + '件');
}

function applyFirewallToAllOrgs() {
  const orgs = getOrganizations();
  const ui = SpreadsheetApp.getUi();
  if (orgs.length === 0) {
    ui.alert(
      '❌ 対象のOrganizationが見つかりません。\n' +
      'OrganizationsシートのD列（Active）をTRUEに設定してください。'
    );
    return;
  }

  const preview = previewFirewallChanges(orgs);
  const approver = promptForApprover('全OrgへのFWルール反映');
  if (approver === null) {
    ui.alert('❌ 承認者が入力されなかったため、処理を中止しました。');
    return;
  }

  if (!showConfirmDialog(
    '⚠️ 確認',
    '全Organization（Active = TRUE）に\nファイアウォールルールを一括反映します。\n\n' +
    '適用予定ルール数: ' + preview.ruleCount + '件\n対象Network数: ' + preview.affectedNetworks + '件\n\n' +
    (isDryRunEnabled() ? '🧪 現在ドライランモードです（実際の変更は行われません）\n\n' : '') +
    'よろしいですか？'
  )) {
    ui.alert('❌ キャンセルしました。');
    return;
  }

  const tmplSheet = getRequiredSheet(SHEET_TMPL_FW);
  const tmplRows = tmplSheet.getDataRange().getValues();
  let successCount = 0;
  let errorCount = 0;
  const errorDetails = [];
  const rules = buildFirewallRulesFromTemplate();

  orgs.forEach(function (org) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      org.name + ' にFWルールを反映しています',
      '🔒 FW反映',
      5
    );

    try {
      const networks = getNetworks(org.orgId, org.apiKey);
      networks.forEach(function (network) {
        if (!hasProductType(network, 'appliance')) return;

        try {
          const result = merakiRequestSafe(
            'PUT',
            '/v1/networks/' + network.id + '/appliance/firewall/l3FirewallRules',
            { rules: rules }, org.apiKey,
            'Firewallルール ' + rules.length + '件'
          );
          const label = result.dryRun ? '🧪 [DRY RUN] 反映予定' : '✅ 反映済み';
          for (let i = 1; i < tmplRows.length; i++) {
            if (tmplRows[i][0] === '' || tmplRows[i][0] === null) continue;
            updateTemplateFWStatus(tmplSheet, i + 1, label + ' (' + org.name + ' / ' + network.name + ')');
          }
          writeMultiOrgLog(
            org.name, 'FWルール反映', network.name,
            result.dryRun ? '🧪 DRY RUN' : '✅ 成功', approver
          );
          successCount++;
        } catch (e) {
          for (let i = 1; i < tmplRows.length; i++) {
            if (tmplRows[i][0] === '' || tmplRows[i][0] === null) continue;
            updateTemplateFWStatus(tmplSheet, i + 1, '❌ エラー: ' + e.message);
          }
          writeMultiOrgLog(org.name, 'FWルール反映', network.name, '❌ エラー: ' + e.message, approver);
          errorCount++;
          errorDetails.push('- **' + org.name + '** / ' + network.name + ': ' + e.message);
        }
        Utilities.sleep(300);
      });
    } catch (e) {
      writeMultiOrgLog(org.name, 'FWルール反映', org.orgId, '❌ エラー: ' + e.message, approver);
      errorCount++;
      errorDetails.push('- **' + org.name + '**: ' + e.message);
    }
  });

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  let webexMsg = '## 🔒 FWルール一括設定 完了通知' +
    (isDryRunEnabled() ? '（🧪 DRY RUN）' : '') + '\n\n';
  webexMsg += '**実行日時:** ' + ts + '\n**承認者:** ' + approver + '\n\n';
  webexMsg += '**結果:** 成功 ' + successCount + '件 / エラー ' + errorCount + '件\n\n';
  webexMsg += errorCount === 0
    ? '✅ **全OrganizationへのFWルール反映が正常に完了しました。**'
    : '⚠️ **一部エラーが発生しました。**\n\n**エラー詳細:**\n' + errorDetails.join('\n');

  sendWebexNotification(webexMsg);
  ui.alert('🎉 FWルール反映が完了しました！\n\n成功: ' + successCount + '件 / エラー: ' + errorCount + '件');
}

function checkDiffAllOrgs() {
  if (!showConfirmDialog(
    '🔍 差分チェック確認',
    '全Organization（Active = TRUE）の\n設定差分をチェックします。\n\nよろしいですか？'
  )) {
    SpreadsheetApp.getUi().alert('❌ キャンセルしました。');
    return;
  }

  const orgs = getOrganizations();
  const diffSheet = ensureDiffReportHeader();
  const lastRow = diffSheet.getLastRow();

  if (lastRow > 1) {
    diffSheet.getRange(2, 1, lastRow - 1, diffSheet.getLastColumn()).clearContent();
  }

  const tmplSheet = getRequiredSheet(SHEET_TMPL_SSID);
  const tmplRows = tmplSheet.getDataRange().getValues();
  const ui = SpreadsheetApp.getUi();
  const compItems = {};
  let diffCount = 0;
  let matchCount = 0;
  const diffDetails = [];

  orgs.forEach(function (org) {
    Logger.log('\n===== 差分チェック: ' + org.name + ' =====');

    try {
      const networks = getNetworks(org.orgId, org.apiKey);
      networks.forEach(function (network) {
        if (!hasProductType(network, 'wireless')) return;

        const currentSSIDs = merakiRequest(
          'GET',
          '/v1/networks/' + network.id + '/wireless/ssids',
          null, org.apiKey
        );

        for (let i = 1; i < tmplRows.length; i++) {
          const row = tmplRows[i];
          const ssidNumber = row[0];
          const ssidName = row[1];
          const enabled = row[2];
          const authMode = row[3];
          const radiusIp = row[5];
          const vlanId = row[8];
          const ipMode = row[11];

          if (ssidNumber === '' || ssidNumber === null) continue;

          const current = currentSSIDs.find(function (s) {
            return s.number === Number(ssidNumber);
          });
          if (!current) continue;

          const authLabel = canonicalAuthModeLabel(authMode);
          const ipModeExpected = ipMode || 'Bridge mode';
          const checks = [
            {
              key: 'SSID' + ssidNumber + '_name',
              label: 'SSID ' + ssidNumber + ' 名前',
              expected: ssidName,
              actual: current.name
            },
            {
              key: 'SSID' + ssidNumber + '_enabled',
              label: 'SSID ' + ssidNumber + ' 有効/無効',
              expected: String(isActiveFlag(enabled)),
              actual: String(current.enabled)
            },
            {
              key: 'SSID' + ssidNumber + '_authMode',
              label: 'SSID ' + ssidNumber + ' 認証モード',
              expected: normalizeAuthMode(authMode),
              actual: current.authMode || ''
            },
            {
              key: 'SSID' + ssidNumber + '_vlan',
              label: 'SSID ' + ssidNumber + ' VLANタギング',
              expected: String(expectedVlanTagging(vlanId, ipModeExpected)),
              actual: String(current.useVlanTagging || false)
            },
            {
              key: 'SSID' + ssidNumber + '_ipMode',
              label: 'SSID ' + ssidNumber + ' IPモード',
              expected: ipModeExpected,
              actual: current.ipAssignmentMode || ''
            }
          ];

          const expectedEnc = expectedWpaEncryptionMode(authMode);
          if (expectedEnc) {
            checks.push({
              key: 'SSID' + ssidNumber + '_wpa',
              label: 'SSID ' + ssidNumber + ' WPA暗号化',
              expected: expectedEnc,
              actual: current.wpaEncryptionMode || ''
            });
          }

          if ((authLabel === 'WPA2 Enterprise' || authLabel === 'WPA3 Enterprise') && radiusIp) {
            checks.push({
              key: 'SSID' + ssidNumber + '_radiusIp',
              label: 'SSID ' + ssidNumber + ' RADIUS IP',
              expected: radiusIp,
              actual: (current.radiusServers && current.radiusServers[0])
                ? current.radiusServers[0].host : ''
            });
          }

          checks.forEach(function (chk) {
            const match = String(chk.actual) === String(chk.expected);
            const result = match ? '✅ 一致' : '⚠️ 不一致';
            const status = match ? '✅ 正常' : '⚠️ 要確認';

            writeDiffReport(
              org.name, network.name, chk.label,
              chk.expected, chk.actual, result, status
            );

            if (!compItems[chk.key]) {
              compItems[chk.key] = {
                label: chk.label,
                templateValue: chk.expected,
                orgValues: {}
              };
            }
            compItems[chk.key].orgValues[org.name] = chk.actual;

            if (!match) {
              diffCount++;
              diffDetails.push(
                '- **' + org.name + '** / ' + network.name + ' / ' + chk.label + ': ' +
                '期待値 `' + chk.expected + '` → 実際 `' + chk.actual + '`'
              );
            } else {
              matchCount++;
            }
          });

          Utilities.sleep(200);
        }
      });

      writeMultiOrgLog(org.name, '差分チェック', org.orgId, '✅ 完了');
    } catch (e) {
      Logger.log('❌ ' + org.name + ' 差分チェックエラー: ' + e.message);
      writeMultiOrgLog(org.name, '差分チェック', org.orgId, '❌ エラー: ' + e.message);
    }
  });

  initComparisonReport(orgs, Object.keys(compItems).map(function (key) {
    return compItems[key];
  }));

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  let webexMsg = '## 🔍 差分チェック 完了通知\n\n';
  webexMsg += '**実行日時:** ' + ts + '\n\n';
  webexMsg += '**対象Org数:** ' + orgs.length + '件\n\n';
  webexMsg += '**結果:** 一致 ' + matchCount + '件 / 不一致 ' + diffCount + '件\n\n';
  webexMsg += diffCount === 0
    ? '✅ **差分なし - 全Orgの設定が統一されています。**'
    : '⚠️ **差分あり - 以下の項目を確認してください。**\n\n**差分詳細:**\n' + diffDetails.join('\n');

  sendWebexNotification(webexMsg);
  ui.alert(
    '🔍 差分チェックが完了しました！\n\n' +
    '一致: ' + matchCount + '件 / 不一致: ' + diffCount + '件\n\n' +
    '・Diff_Report シート：詳細ログ\n' +
    '・Comparison_Report シート：Org横断比較表'
  );
}

function backupAllOrgsSettings() {
  if (!showConfirmDialog(
    '💾 バックアップ確認',
    '全Organization（Active = TRUE）の\n' +
    'SSID・ファイアウォール設定をバックアップします。\n\n' +
    '※ 既存のバックアップに追記されます。\n' +
    '※ SSIDのPSKがAPIから返った場合、Backup_SSIDシートに平文で保存されます。\n\nよろしいですか？'
  )) {
    SpreadsheetApp.getUi().alert('❌ キャンセルしました。');
    return;
  }

  const orgs = getOrganizations();
  const sheets = ensureBackupSheets();
  const ssidSheet = sheets.ssidSheet;
  const fwSheet = sheets.fwSheet;
  const ui = SpreadsheetApp.getUi();
  const timestamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

  if (orgs.length === 0) {
    ui.alert(
      '❌ 対象のOrganizationが見つかりません。\n' +
      'OrganizationsシートのD列（Active）をTRUEに設定してください。'
    );
    return;
  }

  let successCount = 0;
  let errorCount = 0;
  const errorDetails = [];

  orgs.forEach(function (org) {
    Logger.log('\n===== バックアップ開始: ' + org.name + ' =====');

    try {
      const networks = getNetworks(org.orgId, org.apiKey);
      networks.forEach(function (network) {
        if (hasProductType(network, 'wireless')) {
          try {
            const ssids = merakiRequest(
              'GET',
              '/v1/networks/' + network.id + '/wireless/ssids',
              null, org.apiKey
            );

            ssids.forEach(function (ssid) {
              const radiusServer = (ssid.radiusServers && ssid.radiusServers[0])
                ? ssid.radiusServers[0] : null;
              ssidSheet.appendRow([
                timestamp, org.name, org.orgId,
                network.name, network.id,
                ssid.number, ssid.name, ssid.enabled,
                ssid.authMode || '', ssid.psk || '',
                ssid.useVlanTagging || false,
                ssid.ipAssignmentMode || '',
                radiusServer ? radiusServer.host : '',
                radiusServer ? radiusServer.port : '',
                radiusServer && radiusServer.secret ? radiusServer.secret : ''
              ]);
            });

            const tmplSSIDSheet = getRequiredSheet(SHEET_TMPL_SSID);
            const tmplSSIDRows = tmplSSIDSheet.getDataRange().getValues();
            for (let i = 1; i < tmplSSIDRows.length; i++) {
              if (!tmplSSIDRows[i][0]) continue;
              updateTemplateSSIDStatus(
                tmplSSIDSheet, i + 1,
                '💾 バックアップ済み (' + org.name + ' / ' + network.name + ')'
              );
            }

            writeMultiOrgLog(org.name, 'SSIDバックアップ', network.name, '✅ 成功');
            successCount++;
          } catch (e) {
            writeMultiOrgLog(org.name, 'SSIDバックアップ', network.name, '❌ エラー: ' + e.message);
            errorCount++;
            errorDetails.push('- **' + org.name + '** SSID: ' + e.message);
          }
        }

        if (hasProductType(network, 'appliance')) {
          try {
            const fwData = merakiRequest(
              'GET',
              '/v1/networks/' + network.id + '/appliance/firewall/l3FirewallRules',
              null, org.apiKey
            );

            (fwData.rules || []).forEach(function (rule) {
              fwSheet.appendRow([
                timestamp, org.name, org.orgId,
                network.name, network.id,
                rule.policy || '',
                rule.protocol || '',
                rule.srcCidr || '',
                rule.destCidr || '',
                rule.srcPort || 'Any',
                rule.destPort || 'Any'
              ]);
            });

            const tmplFWSheet = getRequiredSheet(SHEET_TMPL_FW);
            const tmplFWRows = tmplFWSheet.getDataRange().getValues();
            for (let i = 1; i < tmplFWRows.length; i++) {
              if (!tmplFWRows[i][0]) continue;
              updateTemplateFWStatus(
                tmplFWSheet, i + 1,
                '💾 バックアップ済み (' + org.name + ' / ' + network.name + ')'
              );
            }

            writeMultiOrgLog(org.name, 'FWバックアップ', network.name, '✅ 成功');
            successCount++;
          } catch (e) {
            writeMultiOrgLog(org.name, 'FWバックアップ', network.name, '❌ エラー: ' + e.message);
            errorCount++;
            errorDetails.push('- **' + org.name + '** FW: ' + e.message);
          }
        }

        Utilities.sleep(300);
      });
    } catch (e) {
      writeMultiOrgLog(org.name, 'バックアップ', org.orgId, '❌ エラー: ' + e.message);
      errorCount++;
      errorDetails.push('- **' + org.name + '**: ' + e.message);
    }
  });

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  let webexMsg = '## 💾 バックアップ 完了通知\n\n';
  webexMsg += '**実行日時:** ' + ts + '\n\n';
  webexMsg += '**結果:** 成功 ' + successCount + '件 / エラー ' + errorCount + '件\n\n';
  webexMsg += errorCount === 0
    ? '✅ **全Orgのバックアップが正常に完了しました。**'
    : '⚠️ **一部エラーが発生しました。**\n\n**エラー詳細:**\n' + errorDetails.join('\n');

  sendWebexNotification(webexMsg);
  ui.alert(
    '💾 バックアップが完了しました！\n\n' +
    '成功: ' + successCount + '件 / エラー: ' + errorCount + '件\n\n' +
    'Log_MultiOrgシートで詳細を確認してください。'
  );
}

function getAvailableBackupTimestamps() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_BACKUP_SSID);
  if (!sheet) return [];

  const rows = sheet.getDataRange().getValues();
  const set = {};
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    const key = String(rows[i][0]);
    if (!set[key]) {
      set[key] = true;
      list.push(key);
    }
  }
  return list.sort().reverse();
}

function rollbackAllOrgsSettings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const timestamps = getAvailableBackupTimestamps();

  if (timestamps.length === 0) {
    ui.alert('❌ バックアップが見つかりません。先にバックアップを実行してください。');
    return;
  }

  const listText = timestamps.map(function (t, idx) {
    return (idx + 1) + '. ' + t + (idx === 0 ? ' (最新)' : '');
  }).join('\n');
  const promptResult = ui.prompt(
    '⏪ ロールバック世代選択',
    '復元したいバックアップ世代の番号を入力してください:\n\n' + listText,
    ui.ButtonSet.OK_CANCEL
  );
  if (promptResult.getSelectedButton() !== ui.Button.OK) {
    ui.alert('❌ キャンセルしました。');
    return;
  }

  const idx = parseInt(promptResult.getResponseText().trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= timestamps.length) {
    ui.alert('❌ 入力が不正です。番号を確認してください。');
    return;
  }
  const targetTimestamp = timestamps[idx];

  const approver = promptForApprover('バックアップ世代「' + targetTimestamp + '」へのロールバック');
  if (approver === null) {
    ui.alert('❌ 承認者が入力されなかったため、処理を中止しました。');
    return;
  }

  if (!showConfirmDialog(
    '⚠️ ロールバック確認',
    'バックアップ世代「' + targetTimestamp + '」の状態に復元します。\n\n' +
    (isDryRunEnabled() ? '🧪 現在ドライランモードです（実際の変更は行われません）\n\n' : '') +
    '⚠️ 現在の設定は上書きされます！\n\nよろしいですか？'
  )) {
    ui.alert('❌ キャンセルしました。');
    return;
  }

  const ssidSheet = ss.getSheetByName(SHEET_BACKUP_SSID);
  const fwSheet = ss.getSheetByName(SHEET_BACKUP_FW);
  let successCount = 0;
  let errorCount = 0;
  const errorDetails = [];

  if (ssidSheet) {
    const ssidRows = ssidSheet.getDataRange().getValues();
    const targetRows = ssidRows.filter(function (row, idx2) {
      return idx2 > 0 && String(row[0]) === String(targetTimestamp);
    });
    const tmplSheet = getRequiredSheet(SHEET_TMPL_SSID);

    targetRows.forEach(function (row) {
      const orgName = row[1];
      const apiKey = _getApiKeyByOrgId(String(row[2]));
      const networkId = row[4];
      const ssidNum = row[5];
      const authMode = row[8];
      const radiusIp = row[12];
      const radiusPort = row[13];
      const radiusSecret = row[14];

      if (!apiKey) {
        Logger.log('⚠️ APIキー未取得: ' + orgName);
        return;
      }

      const payload = {
        name: row[6],
        enabled: isActiveFlag(row[7]),
        authMode: authMode || 'open',
        useVlanTagging: isActiveFlag(row[10]),
        ipAssignmentMode: row[11] || 'Bridge mode'
      };
      if (row[9] && row[9] !== '') {
        payload.psk = row[9];
        payload.encryptionMode = 'wpa';
      }
      if (authMode === '8021x-radius' && radiusIp && radiusIp !== '') {
        payload.encryptionMode = 'wpa';
        payload.wpaEncryptionMode = 'WPA2 only';
        const server = buildRadiusServer(radiusIp, radiusPort, radiusSecret);
        if (server) payload.radiusServers = [server];
      }
      sanitizeVlanTagging(payload, payload.ipAssignmentMode);

      try {
        const result = merakiRequestSafe(
          'PUT', '/v1/networks/' + networkId + '/wireless/ssids/' + ssidNum,
          payload, apiKey, 'SSID' + ssidNum + ' 復元 (' + targetTimestamp + ')'
        );
        const label = result.dryRun ? '🧪 DRY RUN' : '✅ 成功';
        const tmplRows = tmplSheet.getDataRange().getValues();
        for (let i = 1; i < tmplRows.length; i++) {
          if (String(tmplRows[i][0]) === String(ssidNum)) {
            updateTemplateSSIDStatus(
              tmplSheet, i + 1,
              (result.dryRun ? '🧪 [DRY RUN] 復元予定' : '⏪ ロールバック済み') + ' (' + orgName + ')'
            );
            break;
          }
        }
        writeMultiOrgLog(
          orgName, 'SSIDロールバック',
          'Network ' + networkId + ' - SSID ' + ssidNum, label, approver
        );
        successCount++;
      } catch (e) {
        writeMultiOrgLog(
          orgName, 'SSIDロールバック',
          'Network ' + networkId + ' - SSID ' + ssidNum,
          '❌ エラー: ' + e.message, approver
        );
        errorCount++;
        errorDetails.push('- **' + orgName + '** SSID ' + ssidNum + ': ' + e.message);
      }
      Utilities.sleep(300);
    });
  }

  if (fwSheet) {
    const fwRows = fwSheet.getDataRange().getValues();
    const networkRulesMap = {};
    fwRows.forEach(function (row, idx2) {
      if (idx2 === 0) return;
      if (String(row[0]) !== String(targetTimestamp)) return;
      const key = row[2] + '__' + row[4];
      if (!networkRulesMap[key]) {
        networkRulesMap[key] = {
          orgName: row[1],
          orgId: String(row[2]),
          networkId: row[4],
          rules: []
        };
      }
      networkRulesMap[key].rules.push({
        policy: normalizeFWPolicy(row[5]),
        protocol: normalizeFWProtocol(row[6]),
        srcCidr: row[7] || 'Any',
        destCidr: row[8] || 'Any',
        srcPort: normalizeFWPort(row[9]),
        destPort: normalizeFWPort(row[10])
      });
    });

    const tmplFWSheet = getRequiredSheet(SHEET_TMPL_FW);
    Object.keys(networkRulesMap).forEach(function (key) {
      const entry = networkRulesMap[key];
      const apiKey = _getApiKeyByOrgId(entry.orgId);
      if (!apiKey) return;
      try {
        const result = merakiRequestSafe(
          'PUT',
          '/v1/networks/' + entry.networkId + '/appliance/firewall/l3FirewallRules',
          { rules: entry.rules }, apiKey,
          'Firewall復元 (' + targetTimestamp + ')'
        );
        const label = result.dryRun ? '🧪 DRY RUN' : '✅ 成功';
        const tmplFWRows = tmplFWSheet.getDataRange().getValues();
        for (let i = 1; i < tmplFWRows.length; i++) {
          if (!tmplFWRows[i][0]) continue;
          updateTemplateFWStatus(
            tmplFWSheet, i + 1,
            (result.dryRun ? '🧪 [DRY RUN] 復元予定' : '⏪ ロールバック済み') +
            ' (' + entry.orgName + ')'
          );
        }
        writeMultiOrgLog(entry.orgName, 'FWロールバック', entry.networkId, label, approver);
        successCount++;
      } catch (e) {
        writeMultiOrgLog(
          entry.orgName, 'FWロールバック', entry.networkId,
          '❌ エラー: ' + e.message, approver
        );
        errorCount++;
        errorDetails.push('- **' + entry.orgName + '** FW: ' + e.message);
      }
      Utilities.sleep(300);
    });
  }

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  let webexMsg = '## ⏪ ロールバック 完了通知' +
    (isDryRunEnabled() ? '（🧪 DRY RUN）' : '') + '\n\n';
  webexMsg += '**実行日時:** ' + ts + '\n**復元世代:** ' + targetTimestamp +
    '\n**承認者:** ' + approver + '\n\n';
  webexMsg += '**結果:** 成功 ' + successCount + '件 / エラー ' + errorCount + '件\n\n';
  webexMsg += errorCount === 0
    ? '✅ **指定世代への復元が正常に完了しました。**'
    : '⚠️ **一部エラーが発生しました。**\n\n**エラー詳細:**\n' + errorDetails.join('\n');

  sendWebexNotification(webexMsg);
  ui.alert(
    '✅ ロールバックが完了しました！\n\n復元世代: ' + targetTimestamp +
    '\n成功: ' + successCount + '件 / エラー: ' + errorCount + '件'
  );
}

function saveDiffReportToGitHub() {
  if (!showConfirmDialog(
    '📤 GitHub保存確認',
    '差分レポートをGitHubに保存します。\n\nよろしいですか？'
  )) {
    SpreadsheetApp.getUi().alert('❌ キャンセルしました。');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getConfig();
  const githubToken = cfg['GITHUB_TOKEN'];
  const githubOwner = cfg['GITHUB_OWNER'];
  const githubRepo = cfg['GITHUB_REPO'];

  if (!githubToken || !githubOwner || !githubRepo) {
    SpreadsheetApp.getUi().alert(
      '❌ GitHub情報が未設定です。\n' +
      'ConfigシートにGITHUB_TOKEN・GITHUB_OWNER・GITHUB_REPOを入力してください。'
    );
    return;
  }

  const compSheet = ss.getSheetByName(SHEET_COMP_REPORT);
  const compRows = compSheet ? compSheet.getDataRange().getValues() : [];
  const timestamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const tsDisplay = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

  let markdown = '# Meraki Org横断 設定比較レポート\n\n';
  markdown += '**実行日時:** ' + tsDisplay + '\n\n';

  if (compRows.length > 0) {
    const headers = compRows[0];
    markdown += '## 設定比較表\n\n';
    markdown += '| ' + headers.join(' | ') + ' |\n';
    markdown += '| ' + headers.map(function () { return '---'; }).join(' | ') + ' |\n';
    for (let i = 1; i < compRows.length; i++) {
      if (compRows[i][0] === '') continue;
      markdown += '| ' + compRows[i].join(' | ') + ' |\n';
    }
  }

  const diffSheet = ss.getSheetByName(SHEET_DIFF_REPORT);
  const diffRows = diffSheet ? diffSheet.getDataRange().getValues() : [];

  if (diffRows.length > 1) {
    markdown += '\n## 詳細差分ログ\n\n';
    markdown += '| ' + diffRows[0].join(' | ') + ' |\n';
    markdown += '| ' + diffRows[0].map(function () { return '---'; }).join(' | ') + ' |\n';
    for (let i = 1; i < diffRows.length; i++) {
      if (diffRows[i][0] === '') continue;
      markdown += '| ' + diffRows[i].join(' | ') + ' |\n';
    }
  }

  const fileName = 'reports/diff_report_' + timestamp + '.md';
  const content = Utilities.base64Encode(markdown, Utilities.Charset.UTF_8).replace(/[\r\n]/g, '');
  const options = {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + githubToken,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json'
    },
    payload: JSON.stringify({
      message: 'Add diff report ' + timestamp,
      content: content
    }),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(
      'https://api.github.com/repos/' + githubOwner + '/' + githubRepo + '/contents/' + fileName,
      options
    );
    const code = response.getResponseCode();

    if (code === 201) {
      const lastRow = diffSheet ? diffSheet.getLastRow() : 0;
      if (lastRow > 1) {
        updateDiffReportStatus(diffSheet, lastRow, '📤 GitHub保存済み (' + timestamp + ')');
      }
      writeMultiOrgLog('System', 'GitHub保存', fileName, '✅ 成功');
      SpreadsheetApp.getUi().alert('✅ レポートをGitHubに保存しました！\n\nファイル: ' + fileName);
    } else {
      throw new Error('GitHub API Error ' + code + ': ' + response.getContentText());
    }
  } catch (e) {
    writeMultiOrgLog('System', 'GitHub保存', fileName, '❌ エラー: ' + e.message);
    SpreadsheetApp.getUi().alert('❌ GitHub保存エラー:\n' + e.message);
  }
}

function _extractNetworkIdFromStatus(status) {
  const match = String(status).match(/ID:\s*([A-Za-z]_[A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

function deleteNetworksFromSheet() {
  const sheet = ensureNetworkProvisioningHeader();
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const statusCol = headers.indexOf('ステータス');
  const orgIdCol = headers.indexOf('OrgId');
  const nameCol = headers.indexOf('NetworkName');
  const ui = SpreadsheetApp.getUi();
  const targets = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const orgId = row[orgIdCol];
    const networkName = row[nameCol];
    const status = statusCol >= 0 ? row[statusCol] : '';
    const networkId = _extractNetworkIdFromStatus(status);
    if (networkId) {
      targets.push({
        rowIndex: i + 1,
        orgId: orgId,
        networkName: networkName,
        networkId: networkId
      });
    }
  }

  if (targets.length === 0) {
    ui.alert('❌ 削除対象のNetwork（「✅ 作成済み」ステータスのもの）が見つかりません。');
    return;
  }

  const approver = promptForApprover('作成済みNetworkの削除');
  if (approver === null) {
    ui.alert('❌ 承認者が入力されなかったため、処理を中止しました。');
    return;
  }

  if (!showConfirmDialog(
    '🗑 Network削除確認',
    'Network_Provisioningシートで「作成済み」となっている ' + targets.length + '件のNetworkを削除します。\n\n' +
    (isDryRunEnabled() ? '🧪 現在ドライランモードです（実際の削除は行われません）\n\n' : '⚠️ この操作は取り消せません！\n\n') +
    '対象:\n' + targets.map(function (t) {
      return '- ' + t.networkName + ' (' + t.networkId + ')';
    }).join('\n') +
    '\n\nよろしいですか？'
  )) {
    ui.alert('❌ キャンセルしました。');
    return;
  }

  let successCount = 0;
  let errorCount = 0;
  const errorDetails = [];

  targets.forEach(function (t) {
    const orgInfo = _getOrgInfoByOrgId(String(t.orgId));
    if (!orgInfo) {
      updateNetworkProvisioningStatus(sheet, t.rowIndex, '❌ 削除失敗: Org情報が見つかりません');
      errorCount++;
      errorDetails.push('- ' + t.networkName + ': Org情報が見つかりません');
      return;
    }

    try {
      const result = merakiRequestSafe(
        'DELETE',
        '/v1/networks/' + t.networkId,
        null,
        orgInfo.apiKey,
        'Network削除 ' + t.networkName
      );
      if (result && result.dryRun) {
        updateNetworkProvisioningStatus(
          sheet, t.rowIndex, '🧪 [DRY RUN] 削除予定 (ID: ' + t.networkId + ')'
        );
        writeMultiOrgLog(orgInfo.name, 'Network削除', t.networkName, '🧪 DRY RUN', approver);
      } else {
        updateNetworkProvisioningStatus(sheet, t.rowIndex, '🗑 削除済み');
        writeMultiOrgLog(orgInfo.name, 'Network削除', t.networkName, '✅ 成功', approver);
      }
      successCount++;
    } catch (e) {
      updateNetworkProvisioningStatus(sheet, t.rowIndex, '❌ 削除失敗: ' + e.message);
      writeMultiOrgLog(orgInfo.name, 'Network削除', t.networkName, '❌ エラー: ' + e.message, approver);
      errorCount++;
      errorDetails.push('- ' + t.networkName + ': ' + e.message);
    }
    Utilities.sleep(300);
  });

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  let webexMsg = '## 🗑 Network削除 完了通知' +
    (isDryRunEnabled() ? '（🧪 DRY RUN）' : '') + '\n\n';
  webexMsg += '**実行日時:** ' + ts + '\n**承認者:** ' + approver + '\n\n';
  webexMsg += '**結果:** 成功 ' + successCount + '件 / エラー ' + errorCount + '件\n\n';
  webexMsg += errorCount === 0
    ? '✅ **対象Networkの削除が正常に完了しました。**'
    : '⚠️ **一部エラーが発生しました。**\n\n**エラー詳細:**\n' + errorDetails.join('\n');

  sendWebexNotification(webexMsg);
  ui.alert('🗑 Network削除処理が完了しました！\n\n成功: ' + successCount + '件 / エラー: ' + errorCount + '件');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🌏 Meraki Multi-Org 設定')
    .addItem('🏗 新規Networkを作成する（Golden Network方式）', 'provisionNetworksFromSheet')
    .addItem('🗑 作成済みNetworkを削除する（デモ用クリーンアップ）', 'deleteNetworksFromSheet')
    .addSeparator()
    .addItem('📶 全OrgにSSID設定を反映する', 'applySSIDToAllOrgs')
    .addItem('🔒 全OrgにFWルールを反映する', 'applyFirewallToAllOrgs')
    .addSeparator()
    .addItem('🔍 全Orgの設定差分をチェックする', 'checkDiffAllOrgs')
    .addSeparator()
    .addItem('💾 全Orgの設定をバックアップする', 'backupAllOrgsSettings')
    .addItem('⏪ バックアップからロールバックする', 'rollbackAllOrgsSettings')
    .addSeparator()
    .addItem('📤 差分レポートをGitHubに保存する', 'saveDiffReportToGitHub')
    .addItem('🧪 【デモ】SSIDを初期化(Test0/1/2/Open)', 'demoResetSSIDs')
    .addItem('🧪 【デモ】Firewallを初期化(Allow Any)', 'demoResetFirewall')
    .addToUi();
}

function demoResetSSIDs() {
  const ui = SpreadsheetApp.getUi();
  const orgs = getOrganizations();
  if (orgs.length === 0) {
    ui.alert('❌ 対象のOrganizationが見つかりません（D列＝Active TRUE）。');
    return;
  }

  const approver = promptForApprover('デモ用SSID初期化');
  if (approver === null) {
    ui.alert('❌ 承認者が入力されなかったため、処理を中止しました。');
    return;
  }

  if (!showConfirmDialog(
    '🧪 デモ用 SSID初期化',
    '全Organization（Active = TRUE）のSSID 0〜2を\n' +
    '「Test0/Test1/Test2・Open・VLANなし」に初期化します。\n\n' +
    (isDryRunEnabled() ? '🧪 現在ドライランモードです（実際の変更は行われません）\n\n' : '') +
    '⚠️ 現在のSSID設定は上書きされます！\n\nよろしいですか？'
  )) {
    ui.alert('❌ キャンセルしました。');
    return;
  }

  let successCount = 0;
  let errorCount = 0;
  const errorDetails = [];
  const targetSsids = [0, 1, 2];

  orgs.forEach(function (org) {
    Logger.log('\n===== SSID初期化: ' + org.name + ' =====');
    try {
      const networks = getNetworks(org.orgId, org.apiKey);
      networks.forEach(function (network) {
        if (!hasProductType(network, 'wireless')) return;

        targetSsids.forEach(function (num) {
          const payload = {
            name: 'Test' + num,
            enabled: true,
            authMode: 'open',
            useVlanTagging: false,
            ipAssignmentMode: 'NAT mode'
          };

          try {
            const result = merakiRequestSafe(
              'PUT',
              '/v1/networks/' + network.id + '/wireless/ssids/' + num,
              payload, org.apiKey,
              'SSID' + num + ' → Test' + num
            );
            writeMultiOrgLog(
              org.name, 'SSID初期化(デモ)',
              network.name + ' - SSID ' + num + ' (Test' + num + ')',
              result.dryRun ? '🧪 DRY RUN' : '✅ 成功',
              approver
            );
            successCount++;
          } catch (e) {
            writeMultiOrgLog(
              org.name, 'SSID初期化(デモ)',
              network.name + ' - SSID ' + num,
              '❌ エラー: ' + e.message, approver
            );
            errorCount++;
            errorDetails.push(
              '- **' + org.name + '** / ' + network.name + ' / SSID ' + num + ': ' + e.message
            );
          }
          Utilities.sleep(300);
        });
      });
    } catch (e) {
      writeMultiOrgLog(org.name, 'SSID初期化(デモ)', org.orgId, '❌ エラー: ' + e.message, approver);
      errorCount++;
      errorDetails.push('- **' + org.name + '**: ' + e.message);
    }
  });

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  let webexMsg = '## 🧪 【デモ用】SSID初期化 完了通知' +
    (isDryRunEnabled() ? '（🧪 DRY RUN）' : '') + '\n\n';
  webexMsg += '**実行日時:** ' + ts + '\n**承認者:** ' + approver + '\n\n';
  webexMsg += '**内容:** SSID 0〜2 → Test0/1/2・Open・VLANなし\n\n';
  webexMsg += '**結果:** 成功 ' + successCount + '件 / エラー ' + errorCount + '件\n\n';
  webexMsg += errorCount === 0
    ? '✅ **全OrgのSSID初期化が完了しました。**'
    : '⚠️ **一部エラーが発生しました。**\n\n**エラー詳細:**\n' + errorDetails.join('\n');

  sendWebexNotification(webexMsg);
  ui.alert('🧪 SSID初期化（デモ用）が完了しました！\n\n成功: ' + successCount + '件 / エラー: ' + errorCount + '件');
}

function demoResetFirewall() {
  const ui = SpreadsheetApp.getUi();
  const orgs = getOrganizations();
  if (orgs.length === 0) {
    ui.alert('❌ 対象のOrganizationが見つかりません（D列＝Active TRUE）。');
    return;
  }

  const approver = promptForApprover('デモ用Firewall初期化');
  if (approver === null) {
    ui.alert('❌ 承認者が入力されなかったため、処理を中止しました。');
    return;
  }

  if (!showConfirmDialog(
    '🧪 デモ用 Firewall初期化',
    '全Organization（Active = TRUE）のL3ファイアウォールを\n' +
    'デフォルト状態（カスタムルールなし）に初期化します。\n\n' +
    (isDryRunEnabled() ? '🧪 現在ドライランモードです（実際の変更は行われません）\n\n' : '') +
    '⚠️ 現在のカスタムルールはすべて削除されます！\n\nよろしいですか？'
  )) {
    ui.alert('❌ キャンセルしました。');
    return;
  }

  let successCount = 0;
  let errorCount = 0;
  const errorDetails = [];

  orgs.forEach(function (org) {
    Logger.log('\n===== Firewall初期化: ' + org.name + ' =====');
    try {
      const networks = getNetworks(org.orgId, org.apiKey);
      networks.forEach(function (network) {
        if (!hasProductType(network, 'appliance')) return;

        try {
          const result = merakiRequestSafe(
            'PUT',
            '/v1/networks/' + network.id + '/appliance/firewall/l3FirewallRules',
            { rules: [] }, org.apiKey,
            'Firewallカスタムルールを空にする'
          );
          writeMultiOrgLog(
            org.name, 'Firewall初期化(デモ)', network.name,
            result.dryRun ? '🧪 DRY RUN' : '✅ 成功', approver
          );
          successCount++;
        } catch (e) {
          writeMultiOrgLog(
            org.name, 'Firewall初期化(デモ)', network.name,
            '❌ エラー: ' + e.message, approver
          );
          errorCount++;
          errorDetails.push('- **' + org.name + '** / ' + network.name + ': ' + e.message);
        }
        Utilities.sleep(300);
      });
    } catch (e) {
      writeMultiOrgLog(org.name, 'Firewall初期化(デモ)', org.orgId, '❌ エラー: ' + e.message, approver);
      errorCount++;
      errorDetails.push('- **' + org.name + '**: ' + e.message);
    }
  });

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  let webexMsg = '## 🧪 【デモ用】Firewall初期化 完了通知' +
    (isDryRunEnabled() ? '（🧪 DRY RUN）' : '') + '\n\n';
  webexMsg += '**実行日時:** ' + ts + '\n**承認者:** ' + approver + '\n\n';
  webexMsg += '**内容:** カスタムL3ルールを全削除（デフォルトAllow Anyのみ）\n\n';
  webexMsg += '**結果:** 成功 ' + successCount + '件 / エラー ' + errorCount + '件\n\n';
  webexMsg += errorCount === 0
    ? '✅ **全OrgのFirewall初期化が完了しました。**'
    : '⚠️ **一部エラーが発生しました。**\n\n**エラー詳細:**\n' + errorDetails.join('\n');

  sendWebexNotification(webexMsg);
  ui.alert('🧪 Firewall初期化（デモ用）が完了しました！\n\n成功: ' + successCount + '件 / エラー: ' + errorCount + '件');
}

