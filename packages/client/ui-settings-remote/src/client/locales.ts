/** Copy dictionary of the remote-devices Settings page (zh source of truth). */

export const zh = {
  nav: '远程访问',
  intro: '通过 dsh web --remote 配对的设备。设备连续 30 天未使用将自动解绑；任意使用都会刷新该窗口。',
  empty: '暂无已绑定设备',
  loadFailed: '设备列表加载失败',
  retry: '重试',
  boundOn: '绑定于 {date}',
  lastUsedJustNow: '刚刚使用',
  lastUsedMinutesAgo: '{n} 分钟前使用',
  lastUsedHoursAgo: '{n} 小时前使用',
  lastUsedDaysAgo: '{n} 天前使用',
  expiresInDays: '{n} 天后自动解绑',
  expiresToday: '今天自动解绑',
  unbind: '解绑',
  confirmUnbind: '确认解绑',
  cancel: '取消',
  unbindFailed: '解绑失败',
} as const

export type RemoteLocaleKey = keyof typeof zh

/** English counterpart, key-complete with the zh dictionary. */
export const en: Record<RemoteLocaleKey, string> = {
  nav: 'Remote Access',
  intro: 'Devices paired through dsh web --remote. A device unused for 30 consecutive days unbinds automatically; any use refreshes the window.',
  empty: 'No bound devices',
  loadFailed: 'Failed to load devices',
  retry: 'Retry',
  boundOn: 'Bound on {date}',
  lastUsedJustNow: 'used just now',
  lastUsedMinutesAgo: 'used {n} min ago',
  lastUsedHoursAgo: 'used {n} h ago',
  lastUsedDaysAgo: 'used {n} d ago',
  expiresInDays: 'auto-unbinds in {n} days',
  expiresToday: 'auto-unbinds today',
  unbind: 'Unbind',
  confirmUnbind: 'Confirm unbind',
  cancel: 'Cancel',
  unbindFailed: 'Unbind failed',
}
