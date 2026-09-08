/** Desktop remote-control panel copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'footerAction': '远程控制',
  'panel.title': '移动端远程控制',
  'panel.subtitle': '扫码或在手机上打开链接，即可远程控制当前工作区',
  'scan.label': '手机扫码连接',
  'tunnel.open': '隧道已开启',
  'tunnel.down': '隧道未开启',
  'tunnel.failed': '隧道连接失败',
  'devices.title': '已配对设备',
  'devices.empty': '暂无已配对设备',
  'device.online': '在线',
  'device.offline': '离线',
  'device.expiry': '有效期 {days} 天',
  'device.rename': '改名',
  'device.renameSave': '保存',
  'device.renameCancel': '取消',
  'device.renameError': '改名失败',
  'device.revoke': '吊销',
  'stop': '停止',
  'stop.confirm': '确定停止远程控制？所有已配对设备将被吊销。',
  'stop.confirmAction': '确认停止',
  'refreshQr': '刷新二维码',
  'copyLink': '复制链接',
  'pair.unavailable': '隧道未开启，无法生成配对二维码',
  'load.error': '加载远程状态失败',
} satisfies Record<string, string>

/** The remote namespace key union. */
export type RemoteKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'footerAction': 'Remote',
  'panel.title': 'Mobile Remote Control',
  'panel.subtitle': 'Scan the code or open the link on your phone to control this workspace remotely',
  'scan.label': 'Scan to connect from your phone',
  'tunnel.open': 'Tunnel open',
  'tunnel.down': 'Tunnel closed',
  'tunnel.failed': 'Tunnel connection failed',
  'devices.title': 'Paired devices',
  'devices.empty': 'No paired devices',
  'device.online': 'Online',
  'device.offline': 'Offline',
  'device.expiry': '{days}d left',
  'device.rename': 'Rename',
  'device.renameSave': 'Save',
  'device.renameCancel': 'Cancel',
  'device.renameError': 'Failed to rename device',
  'device.revoke': 'Revoke',
  'stop': 'Stop',
  'stop.confirm': 'Stop remote control? All paired devices will be revoked.',
  'stop.confirmAction': 'Confirm stop',
  'refreshQr': 'Refresh QR code',
  'copyLink': 'Copy link',
  'pair.unavailable': 'Tunnel is closed; no pairing QR code is available',
  'load.error': 'Failed to load remote status',
} satisfies Record<RemoteKey, string>
