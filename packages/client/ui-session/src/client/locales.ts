/** Completion-notification dictionaries owned by the Session UI adapter. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'notify.title': '任务已完成',
  'notify.body': '{title}',
  'notify.denied': '系统通知已被浏览器拒绝，请在站点设置中允许通知',
  'notify.unsupported': '当前浏览器不支持系统通知',
  'settings.notify.title': '任务完成通知',
  'settings.notify.description': '页面在后台时，会话结束运行后弹出系统通知',
  'settings.notify.error': '保存失败，请重试',
}

/** English dictionary. */
export const en: typeof zh = {
  'notify.title': 'Task finished',
  'notify.body': '{title}',
  'notify.denied': 'System notifications are blocked by the browser. Allow them in site settings.',
  'notify.unsupported': 'System notifications are not supported in this browser',
  'settings.notify.title': 'Task completion notifications',
  'settings.notify.description': 'Show a system notification when a session stops running while the page is in the background',
  'settings.notify.error': 'Could not save. Please try again.',
}

/** Japanese dictionary. */
export const ja: typeof zh = {
  'notify.title': 'タスクが完了しました',
  'notify.body': '{title}',
  'notify.denied': 'システム通知がブラウザーに拒否されています。サイト設定で許可してください',
  'notify.unsupported': 'このブラウザーはシステム通知に対応していません',
  'settings.notify.title': 'タスク完了通知',
  'settings.notify.description': 'ページがバックグラウンドのとき、セッションの実行終了後にシステム通知を表示します',
  'settings.notify.error': '保存できませんでした。もう一度お試しください',
}

/** Spanish dictionary. */
export const es: typeof zh = {
  'notify.title': 'Tarea finalizada',
  'notify.body': '{title}',
  'notify.denied': 'El navegador bloquea las notificaciones del sistema. Permítelas en la configuración del sitio.',
  'notify.unsupported': 'Este navegador no admite notificaciones del sistema',
  'settings.notify.title': 'Notificaciones de tareas completadas',
  'settings.notify.description': 'Muestra una notificación del sistema cuando una sesión termina de ejecutarse con la página en segundo plano',
  'settings.notify.error': 'No se pudo guardar. Inténtalo de nuevo.',
}

/** French dictionary. */
export const fr: typeof zh = {
  'notify.title': 'Tâche terminée',
  'notify.body': '{title}',
  'notify.denied': 'Les notifications système sont bloquées par le navigateur. Autorisez-les dans les paramètres du site.',
  'notify.unsupported': 'Ce navigateur ne prend pas en charge les notifications système',
  'settings.notify.title': 'Notifications de fin de tâche',
  'settings.notify.description': 'Affiche une notification système quand une session termine son exécution pendant que la page est en arrière-plan',
  'settings.notify.error': "Échec de l'enregistrement. Réessayez.",
}

/** German dictionary. */
export const de: typeof zh = {
  'notify.title': 'Aufgabe abgeschlossen',
  'notify.body': '{title}',
  'notify.denied': 'Systembenachrichtigungen werden vom Browser blockiert. Erlauben Sie sie in den Websiteeinstellungen.',
  'notify.unsupported': 'Dieser Browser unterstützt keine Systembenachrichtigungen',
  'settings.notify.title': 'Benachrichtigungen bei Abschluss',
  'settings.notify.description': 'Zeigt eine Systembenachrichtigung, wenn eine Session im Hintergrund der Seite endet',
  'settings.notify.error': 'Speichern fehlgeschlagen. Bitte erneut versuchen.',
}

/** Russian dictionary. */
export const ru: typeof zh = {
  'notify.title': 'Задача завершена',
  'notify.body': '{title}',
  'notify.denied': 'Системные уведомления заблокированы браузером. Разрешите их в настройках сайта.',
  'notify.unsupported': 'Этот браузер не поддерживает системные уведомления',
  'settings.notify.title': 'Уведомления о завершении задач',
  'settings.notify.description': 'Показывает системное уведомление, когда сессия завершает работу при свёрнутой странице',
  'settings.notify.error': 'Не удалось сохранить. Повторите попытку.',
}

/** Portuguese dictionary. */
export const pt: typeof zh = {
  'notify.title': 'Tarefa concluída',
  'notify.body': '{title}',
  'notify.denied': 'As notificações do sistema estão bloqueadas pelo navegador. Permita-as nas configurações do site.',
  'notify.unsupported': 'Este navegador não suporta notificações do sistema',
  'settings.notify.title': 'Notificações de conclusão de tarefas',
  'settings.notify.description': 'Mostra uma notificação do sistema quando uma sessão para de executar com a página em segundo plano',
  'settings.notify.error': 'Não foi possível salvar. Tente novamente.',
}

/** Locale keys owned by this namespace. */
export type SessionNotifyKey = keyof typeof zh
