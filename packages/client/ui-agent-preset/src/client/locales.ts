/** Locale bundles for the agent-preset hero chip, header label, and management section. */

import { guideEn, guideJa, guideEs, guideFr, guideDe, guideRu, guidePt, guideZh, type PresetGuideKey } from './guide-locales.ts'

/** Locale keys these surfaces render. */
export type AgentPresetSettingsKey =
  | PresetGuideKey
  | 'builtInGroup'
  | 'customGroup'
  | 'seatHint'
  | 'headerHint'
  | 'crewChoiceLabel'
  | 'crewChoiceTriggerLabel'
  | 'crewChoiceGone'
  | 'crewChoiceIncomplete'
  | 'crewChoiceUnserved'
  | 'crewChoiceConflict'
  | 'crewChoiceConflictNamed'
  | 'crewRoutesLoading'
  | 'crewRoutesApplied'
  | 'crewRoutesUnnamed'
  | 'crewRoutesUnapplied'
  | 'crewRoutesUnappliedHint'
  | 'crewRoutesUnavailable'
  | 'crewRoutesUnavailableHint'
  | 'crewRoutesError'
  | 'crewRoutesErrorHint'
  | 'crewRoutesRetry'
  | 'crewRoutesWorker'
  | 'crewRoutesPlanner'
  | 'crewRoutesReviewer'
  | 'crewRoutesRoute'
  | 'crewRouteRepairAction'
  | 'crewRouteRepairTitle'
  | 'crewRouteRepairDescription'
  | 'crewRouteRepairRole'
  | 'crewRouteRepairProvider'
  | 'crewRouteRepairModel'
  | 'crewRouteRepairEffort'
  | 'crewRouteRepairCancel'
  | 'crewRouteRepairConfirm'
  | 'crewRouteRepairLoading'
  | 'crewRouteRepairCatalogFailed'
  | 'crewRouteRepairPartial'
  | 'crewRouteRepairFailed'
  | 'crewChoiceRefused'
  | 'nav'
  | 'sectionIntro'
  | 'setDefault'
  | 'view'
  | 'presetStandardName'
  | 'presetStandardDescription'
  | 'presetPtcName'
  | 'presetPtcDescription'
  | 'presetMinimalName'
  | 'presetMinimalDescription'
  | 'presetCordisName'
  | 'presetCordisDescription'
  | 'presetCrewName'
  | 'presetCrewDescription'
  | 'inUse'
  | 'noDescription'
  | 'brokenBadge'
  | 'switchRefused'
  | 'standardUnavailable'
  | 'close'
  | 'creatorDraft'
  | 'createPlugin'
  | 'createPluginDescription'
  | 'createPluginChecking'
  | 'createPluginUnavailable'
  | 'createPluginMissing'

/** English copy. */
export const en: Record<AgentPresetSettingsKey, string> = {
  ...guideEn,
  builtInGroup: 'Built-in', customGroup: 'Custom',
  sectionIntro: 'Choose the agent’s tools and how it works. Use Standard mode for everyday tasks, or Creator mode to add capabilities to DSH.',

  seatHint: 'Choose the agent preset for your new task',
  headerHint: 'The agent preset chosen when this task started',
  crewChoiceLabel: 'Model combination',
  crewChoiceTriggerLabel: 'Model combination: {name}',
  crewChoiceGone: 'That combination is no longer stored. Pick another one.',
  crewChoiceIncomplete: 'That combination does not name all three roles. Complete it in Models settings.',
  crewChoiceUnserved: 'This deployment serves no crew formation, so the combination cannot be applied.',
  crewChoiceRefused: 'The model combination could not be applied: {reason}',
  crewChoiceConflict: 'This session already runs another model combination. The pick was kept for the next crew session.',
  crewChoiceConflictNamed: 'This session already runs “{recorded}”. The pick was kept for the next crew session.',
  crewRoutesLoading: 'Crew · reading the combination…',
  crewRoutesApplied: 'Crew · {name}',
  crewRoutesUnnamed: 'Unnamed combination',
  crewRoutesUnapplied: 'No combination applied · roles use their defaults',
  crewRoutesUnappliedHint: 'This session recorded no combination, so the worker, planner, and reviewer each run their own default route.',
  crewRoutesUnavailable: 'Crew formation not served',
  crewRoutesUnavailableHint: 'This deployment mounts no crew formation, so this session’s combination cannot be read.',
  crewRoutesError: 'Could not read the Crew combination',
  crewRoutesErrorHint: 'Could not read this session’s Crew combination: {message}',
  crewRoutesRetry: 'Retry',
  crewRoutesWorker: 'Worker',
  crewRoutesPlanner: 'Planner',
  crewRoutesReviewer: 'Reviewer',
  crewRoutesRoute: '{role} · {provider} · {model} · {reasoningEffort}',
  crewRouteRepairAction: 'Change route',
  crewRouteRepairTitle: 'Change a Crew role route',
  crewRouteRepairDescription: 'Change only this session’s selected role. This does not retry the failed task; ask the commander to continue the original subagent after the change.',
  crewRouteRepairRole: 'Role to change',
  crewRouteRepairProvider: 'Provider',
  crewRouteRepairModel: 'Model',
  crewRouteRepairEffort: 'Reasoning effort',
  crewRouteRepairCancel: 'Cancel',
  crewRouteRepairConfirm: 'Change route',
  crewRouteRepairLoading: 'Loading available routes…',
  crewRouteRepairCatalogFailed: 'Could not load available routes: {message}',
  crewRouteRepairPartial: 'Some provider catalogs could not be read. Available routes remain selectable.',
  crewRouteRepairFailed: 'Could not change the route: {message}',
  nav: 'Agent presets',

  setDefault: 'Set as new task default',
  view: 'View configuration',

  presetStandardName: 'Standard mode',
  presetStandardDescription:
    'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
  presetPtcName: 'PTC mode',
  presetPtcDescription:
    'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  presetMinimalName: 'Minimal mode',
  presetMinimalDescription:
    'The agent uses a terminal and image reading, with context compaction. Useful for testing and comparing its basic performance.',
  presetCordisName: 'Creator mode',
  presetCordisDescription:
    'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',
  presetCrewName: 'Crew',
  presetCrewDescription:
    'Crew pairs a commander with three delegation roles: Worker for implementation, Planner for design, and Reviewer for audit. The commander reads and splits the request, delegates work, verifies deliveries, and reports. It has no general shell or filesystem writer; Worker handles implementation. Git uses the structured crew_git tool and asks before writes. A process-wide guard serializes compile and install commands. Use built-in plan mode and ask_user_question.',

  inUse: 'New task default',

  noDescription: 'No description.',
  brokenBadge: 'Failed to load',

  switchRefused: 'Could not switch to {name}: {reason}',
  standardUnavailable: 'Standard mode is unavailable. Restore it or choose another available mode.',

  close: 'Close',

  creatorDraft: 'Let the agent help me create a preset',
  createPlugin: 'Let the agent create a plugin',
  createPluginDescription: 'Enter Creator mode and make your own DSH plugin',
  createPluginChecking: 'Checking whether Creator mode is available',
  createPluginUnavailable: 'Temporarily unavailable. Reopen this menu to retry',
  createPluginMissing: 'Creator mode is not included in this configuration',

}

/** Simplified Chinese copy. */
export const zh: Record<AgentPresetSettingsKey, string> = {
  ...guideZh,
  builtInGroup: '内置', customGroup: '自定义',
  sectionIntro: '选择 Agent 的工具和工作方式。日常任务用「标准模式」，扩展 DSH 的能力用「创造模式」。',

  seatHint: '选择新任务使用的 Agent 预设',
  headerHint: '本任务的 Agent 预设，在任务开始时确定',
  crewChoiceLabel: '模型组合',
  crewChoiceTriggerLabel: '模型组合：{name}',
  crewChoiceGone: '该组合已不存在，请重新选择。',
  crewChoiceIncomplete: '该组合未包含全部三个角色，请到「模型」设置里补全。',
  crewChoiceUnserved: '当前部署未提供 Crew 编队，无法应用该组合。',
  crewChoiceRefused: '模型组合未能应用：{reason}',
  crewChoiceConflict: '该会话已在运行另一个模型组合。已保留所选组合，供下一个 Crew 会话使用。',
  crewChoiceConflictNamed: '该会话已在运行「{recorded}」。已保留所选组合，供下一个 Crew 会话使用。',
  crewRoutesLoading: 'Crew · 读取组合…',
  crewRoutesApplied: 'Crew · {name}',
  crewRoutesUnnamed: '未命名组合',
  crewRoutesUnapplied: '未应用组合 · 使用角色默认路由',
  crewRoutesUnappliedHint: '本会话未记录组合，工人、规划者和审核者各自使用默认路由。',
  crewRoutesUnavailable: '当前部署未提供 Crew 编队',
  crewRoutesUnavailableHint: '当前部署未挂载 Crew 编队，无法读取本会话的组合。',
  crewRoutesError: 'Crew 组合读取失败',
  crewRoutesErrorHint: 'Crew 组合读取失败：{message}',
  crewRoutesRetry: '重试',
  crewRoutesWorker: '工人',
  crewRoutesPlanner: '规划者',
  crewRoutesReviewer: '审核者',
  crewRoutesRoute: '{role} · {provider} · {model} · {reasoningEffort}',
  crewRouteRepairAction: '换路',
  crewRouteRepairTitle: '更换 Crew 角色路由',
  crewRouteRepairDescription: '只修改本会话选中的角色，不会自动重试失败任务。换路后请让指挥续作原子代理。',
  crewRouteRepairRole: '要切换的角色',
  crewRouteRepairProvider: '提供方',
  crewRouteRepairModel: '模型',
  crewRouteRepairEffort: '思考等级',
  crewRouteRepairCancel: '取消',
  crewRouteRepairConfirm: '确认换路',
  crewRouteRepairLoading: '正在读取可用路由…',
  crewRouteRepairCatalogFailed: '可用路由读取失败：{message}',
  crewRouteRepairPartial: '部分提供方目录读取失败，仍可选择已读取的路由。',
  crewRouteRepairFailed: '路由切换失败：{message}',
  nav: 'Agent 预设',

  setDefault: '设为新任务默认',
  view: '查看配置',

  presetStandardName: '标准模式',
  presetStandardDescription: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
  presetPtcName: 'PTC 模式',
  presetPtcDescription: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  presetMinimalName: '极简模式',
  presetMinimalDescription: 'Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。',
  presetCordisName: '创造模式',
  presetCordisDescription: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
  presetCrewName: 'Crew',
  presetCrewDescription: 'Crew 由指挥者与三个委派角色组成：工人负责实现，规划者负责设计，审核者负责审核。指挥者读取并拆分请求，委派工作，验证交付并汇报。指挥者没有通用 shell 或文件系统写入工具，实现工作由工人完成。Git 使用结构化的 crew_git 工具，并在写入前询问。编译和安装命令由守卫在进程范围内串行执行。使用内置计划模式和 ask_user_question。',

  inUse: '新任务默认',

  noDescription: '暂无描述。',
  brokenBadge: '加载失败',

  switchRefused: '无法切换到「{name}」：{reason}',
  standardUnavailable: '标准模式不可用，请恢复该模式或选择其他可用模式。',

  close: '关闭',

  creatorDraft: '让 Agent 帮我创建预设模式',
  createPlugin: '让 Agent 创建插件',
  createPluginDescription: '进入创造模式，制作属于你的 DSH 插件',
  createPluginChecking: '正在确认创造模式是否可用',
  createPluginUnavailable: '暂时不可用，请重新打开菜单重试',
  createPluginMissing: '当前配置未提供创造模式',

}

// The resolution itself is the shared fold in `dsh-agent-preset-registry/display`,
// re-exported here so every surface in this plugin reads one path; the
// Settings plugin list inlines the same fold over this plugin's dictionaries.
export { isBuiltInPreset, presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
export type { PresetDisplaySource, PresetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'

/** Japanese copy, checked against the English keys. */
export const ja = {
  ...guideJa,
  'builtInGroup': '組み込み',
  'customGroup': 'カスタム',
  'sectionIntro': 'エージェントのツールと動作を選択します。日々のタスクには標準モードを、DSH に機能を追加するにはクリエイターモードを使用してください。',
  'seatHint': '新しいタスクで使用するエージェントプリセットを選択',
  'headerHint': 'このタスクの開始時に選択されたエージェントプリセット',
  crewChoiceLabel: 'モデルの組み合わせ',
  crewChoiceTriggerLabel: 'モデルの組み合わせ: {name}',
  crewChoiceGone: 'その組み合わせは保存されていません。別の組み合わせを選んでください。',
  crewChoiceIncomplete: 'その組み合わせには3つのロールがすべて含まれていません。モデル設定で完成させてください。',
  crewChoiceUnserved: 'この配置はCrew編成を提供していないため、組み合わせを適用できません。',
  crewChoiceRefused: 'モデルの組み合わせを適用できませんでした: {reason}',
  crewChoiceConflict: 'このセッションはすでに別のモデルの組み合わせで実行されています。選択は次のCrewセッションのために保持されました。',
  crewChoiceConflictNamed: 'このセッションはすでに「{recorded}」で実行されています。選択は次のCrewセッションのために保持されました。',
  crewRoutesLoading: 'Crew · 組み合わせを読み込み中…',
  crewRoutesApplied: 'Crew · {name}',
  crewRoutesUnnamed: '名前のない組み合わせ',
  crewRoutesUnapplied: '組み合わせ未適用 · ロールの既定ルートを使用',
  crewRoutesUnappliedHint: 'このセッションは組み合わせを記録していないため、ワーカー・プランナー・レビュアーはそれぞれの既定ルートで実行されます。',
  crewRoutesUnavailable: 'Crew編成は提供されていません',
  crewRoutesUnavailableHint: 'このデプロイにはCrew編成がないため、このセッションの組み合わせを読み取れません。',
  crewRoutesError: 'Crewの組み合わせを読み取れませんでした',
  crewRoutesErrorHint: 'Crewの組み合わせを読み取れませんでした：{message}',
  crewRoutesRetry: '再試行',
  crewRoutesWorker: 'ワーカー',
  crewRoutesPlanner: 'プランナー',
  crewRoutesReviewer: 'レビュアー',
  crewRoutesRoute: '{role} · {provider} · {model} · {reasoningEffort}',
  crewRouteRepairAction: 'ルート変更',
  crewRouteRepairTitle: 'Crewロールのルートを変更',
  crewRouteRepairDescription: 'このセッションで選択したロールだけを変更し、失敗したタスクは自動再試行しません。変更後はコマンダーに元のサブエージェントの続行を依頼してください。',
  crewRouteRepairRole: '変更するロール',
  crewRouteRepairProvider: 'プロバイダー',
  crewRouteRepairModel: 'モデル',
  crewRouteRepairEffort: '推論レベル',
  crewRouteRepairCancel: 'キャンセル',
  crewRouteRepairConfirm: 'ルートを変更',
  crewRouteRepairLoading: '利用可能なルートを読み込んでいます…',
  crewRouteRepairCatalogFailed: '利用可能なルートを読み込めませんでした：{message}',
  crewRouteRepairPartial: '一部のプロバイダーカタログを読み取れませんでした。取得済みのルートは選択できます。',
  crewRouteRepairFailed: 'ルートを変更できませんでした：{message}',
  'nav': 'エージェントプリセット',
  'setDefault': '新しいタスクの既定に設定',
  'view': '設定を表示',
  'presetStandardName': '標準モード',
  'presetStandardDescription': 'コード、ファイル、情報を扱います。検索、編集、ターミナルコマンドなどのツールを必要に応じて利用でき、ほとんどのタスクに適しています。',
  'presetPtcName': 'PTC モード',
  'presetPtcDescription': '標準モードのすべての機能を含みます。ツールを一括で呼び出し、その結果を絞り込み、整理、重複排除、集計、要約するタスクに適しています。',
  'presetMinimalName': '最小モード',
  'presetMinimalDescription': 'エージェントはターミナルと画像読み取りを使用し、コンテキスト圧縮にも対応します。基本的な性能のテストや比較に役立ちます。',
  'presetCordisName': 'クリエイターモード',
  'presetCordisDescription': '会話を通じて DSH をカスタマイズします。機能や UI を追加するプラグインをエージェントに書かせたり、ツールとプロンプトを組み合わせて独自のモードを作成したりできます。',
  presetCrewName: 'Crew',
  presetCrewDescription: 'Crewは、コマンダーと3つの委譲ロールで構成されます。実装はワーカー、設計はプランナー、監査はレビュアーが担当します。コマンダーはリクエストの読み取りと分割、作業の委譲、成果物の検証、報告を行います。コマンダーには汎用シェルやファイルシステム書き込み機能がなく、実装はワーカーが行います。Gitには構造化されたcrew_gitツールを使用し、書き込み前に確認します。コンパイルとインストールのコマンドは、ガードによってプロセス全体で直列化されます。組み込みのプランモードとask_user_questionを使用します。',
  'inUse': '新しいタスクの既定',
  'noDescription': '説明はありません。',
  'brokenBadge': '読み込みに失敗',
  'switchRefused': '{name} に切り替えられませんでした: {reason}',
  'standardUnavailable': '標準モードは利用できません。復元するか、利用可能な別のモードを選択してください。',
  'close': '閉じる',
  'creatorDraft': 'エージェントにプリセット作成を手伝ってもらう',
  'createPlugin': 'エージェントにプラグインを作成してもらう',
  'createPluginDescription': 'クリエイターモードに入り、独自の DSH プラグインを作成',
  'createPluginChecking': 'クリエイターモードが利用可能か確認中',
  'createPluginUnavailable': '一時的に利用できません。このメニューを開き直して再試行してください',
  'createPluginMissing': 'この構成にはクリエイターモードが含まれていません',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  ...guideEs,
  builtInGroup: 'Incorporado', customGroup: 'personalizado',
  sectionIntro: 'Elija las herramientas del agente y cómo funciona. Utilice el modo Estándar para las tareas diarias o el modo Creador para agregar capacidades a DSH.',

  seatHint: 'Elija el agente preestablecido para su nueva tarea',
  headerHint: 'El agente preestablecido elegido cuando comenzó esta tarea',
  crewChoiceLabel: 'Combinación de modelos',
  crewChoiceTriggerLabel: 'Combinación de modelos: {name}',
  crewChoiceGone: 'Esa combinación ya no está guardada. Elija otra.',
  crewChoiceIncomplete: 'Esa combinación no nombra los tres roles. Complétela en los ajustes de Modelos.',
  crewChoiceUnserved: 'Esta implementación no ofrece formación de crew, así que la combinación no se puede aplicar.',
  crewChoiceRefused: 'No se pudo aplicar la combinación de modelos: {reason}',
  crewChoiceConflict: 'Esta sesión ya ejecuta otra combinación de modelos. La elección se conservó para la próxima sesión de crew.',
  crewChoiceConflictNamed: 'Esta sesión ya ejecuta «{recorded}». La elección se conservó para la próxima sesión de crew.',
  crewRoutesLoading: 'Crew · leyendo la combinación…',
  crewRoutesApplied: 'Crew · {name}',
  crewRoutesUnnamed: 'Combinación sin nombre',
  crewRoutesUnapplied: 'Sin combinación aplicada · los roles usan sus valores predeterminados',
  crewRoutesUnappliedHint: 'Esta sesión no registró ninguna combinación, así que el trabajador, el planificador y el revisor usan cada uno su ruta predeterminada.',
  crewRoutesUnavailable: 'La formación de crew no está disponible',
  crewRoutesUnavailableHint: 'Esta implementación no incluye la formación de crew, así que no se puede leer la combinación de esta sesión.',
  crewRoutesError: 'No se pudo leer la combinación de Crew',
  crewRoutesErrorHint: 'No se pudo leer la combinación de Crew de esta sesión: {message}',
  crewRoutesRetry: 'Reintentar',
  crewRoutesWorker: 'Trabajador',
  crewRoutesPlanner: 'Planificador',
  crewRoutesReviewer: 'Revisor',
  crewRoutesRoute: '{role} · {provider} · {model} · {reasoningEffort}',
  crewRouteRepairAction: 'Cambiar ruta',
  crewRouteRepairTitle: 'Cambiar la ruta de un rol de Crew',
  crewRouteRepairDescription: 'Cambia solo el rol seleccionado de esta sesión. No reintenta la tarea fallida; pide al comandante que continúe el subagente original después del cambio.',
  crewRouteRepairRole: 'Rol que se cambiará',
  crewRouteRepairProvider: 'Proveedor',
  crewRouteRepairModel: 'Modelo',
  crewRouteRepairEffort: 'Nivel de razonamiento',
  crewRouteRepairCancel: 'Cancelar',
  crewRouteRepairConfirm: 'Cambiar ruta',
  crewRouteRepairLoading: 'Cargando rutas disponibles…',
  crewRouteRepairCatalogFailed: 'No se pudieron cargar las rutas disponibles: {message}',
  crewRouteRepairPartial: 'No se pudieron leer algunos catálogos de proveedores. Las rutas disponibles siguen siendo seleccionables.',
  crewRouteRepairFailed: 'No se pudo cambiar la ruta: {message}',
  nav: 'Ajustes preestablecidos del agente',

  setDefault: 'Establecer como nueva tarea predeterminada',
  view: 'Ver configuración',

  presetStandardName: 'Modo estándar',
  presetStandardDescription:
    'Trabaje con código, archivos e información. Adecuado para la mayoría de las tareas, con búsqueda, edición, comandos de terminal y otras herramientas disponibles según sea necesario.',
  presetPtcName: 'Modo PTC',
  presetPtcDescription:
    'Incluye todas las capacidades del modo Estándar. Más adecuado para tareas que llaman a herramientas en lotes y luego filtran, organizan, deduplican, cuentan o resumen los resultados.',
  presetMinimalName: 'modo mínimo',
  presetMinimalDescription:
    'El agente utiliza un terminal y lectura de imágenes, con compactación de contexto. Útil para probar y comparar su rendimiento básico.',
  presetCordisName: 'Modo creador',
  presetCordisDescription:
    'Personaliza DSH a través de la conversación. Deje que el agente escriba complementos que agreguen funciones o interfaz de usuario, o combine herramientas e indicaciones para crear su propio modo.',
  presetCrewName: 'Crew',
  presetCrewDescription:
    'Crew combina un comandante con tres roles delegados: Trabajador para la implementación, Planificador para el diseño y Revisor para la auditoría. El comandante lee y divide la solicitud, delega el trabajo, verifica las entregas e informa. No dispone de un shell general ni de escritura en el sistema de archivos; Trabajador realiza la implementación. Git usa la herramienta estructurada crew_git y pide confirmación antes de escribir. Un mecanismo de protección serializa los comandos de compilación e instalación en todo el proceso. Usa el modo de plan integrado y ask_user_question.',

  inUse: 'Nueva tarea predeterminada',

  noDescription: 'Sin descripción.',
  brokenBadge: 'No se pudo cargar',

  switchRefused: 'No se pudo cambiar a {name}: {reason}',
  standardUnavailable: 'El modo estándar no está disponible. Restáuralo o elige otro modo disponible.',

  close: 'Cerrar',

  creatorDraft: 'Deja que el agente me ayude a crear un preset',
  createPlugin: 'Deje que el agente cree un complemento',
  createPluginDescription: 'Ingrese al modo Creador y cree su propio complemento DSH',
  createPluginChecking: 'Comprobando si el modo Creador está disponible',
  createPluginUnavailable: 'Temporalmente no disponible. Vuelve a abrir este menú para volver a intentarlo.',
  createPluginMissing: 'El modo creador no está incluido en esta configuración.',

} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  ...guideFr,
  builtInGroup: 'Intégré', customGroup: 'Personnalisé',
  sectionIntro: 'Choisissez les outils de l’agent et son fonctionnement. Utilisez le mode Standard pour les tâches quotidiennes ou le mode Créateur pour ajouter des fonctionnalités à DSH.',

  seatHint: "Choisissez le préréglage d'agent pour votre nouvelle tâche",
  headerHint: "Le préréglage d'agent choisi au démarrage de cette tâche",
  crewChoiceLabel: 'Combinaison de modèles',
  crewChoiceTriggerLabel: 'Combinaison de modèles : {name}',
  crewChoiceGone: "Cette combinaison n'est plus enregistrée. Choisissez-en une autre.",
  crewChoiceIncomplete: 'Cette combinaison ne nomme pas les trois rôles. Complétez-la dans les réglages Modèles.',
  crewChoiceUnserved: 'Ce déploiement ne fournit pas de formation crew, la combinaison ne peut donc pas être appliquée.',
  crewChoiceRefused: "La combinaison de modèles n'a pas pu être appliquée : {reason}",
  crewChoiceConflict: 'Cette session exécute déjà une autre combinaison de modèles. Le choix a été conservé pour la prochaine session crew.',
  crewChoiceConflictNamed: 'Cette session exécute déjà « {recorded} ». Le choix a été conservé pour la prochaine session crew.',
  crewRoutesLoading: 'Crew · lecture de la combinaison…',
  crewRoutesApplied: 'Crew · {name}',
  crewRoutesUnnamed: 'Combinaison sans nom',
  crewRoutesUnapplied: 'Aucune combinaison appliquée · les rôles utilisent leurs valeurs par défaut',
  crewRoutesUnappliedHint: 'Cette session n’a enregistré aucune combinaison : le worker, le planificateur et le réviseur utilisent chacun leur route par défaut.',
  crewRoutesUnavailable: 'La formation crew n’est pas fournie',
  crewRoutesUnavailableHint: 'Ce déploiement ne monte aucune formation crew : la combinaison de cette session ne peut pas être lue.',
  crewRoutesError: 'Impossible de lire la combinaison Crew',
  crewRoutesErrorHint: 'Impossible de lire la combinaison Crew de cette session : {message}',
  crewRoutesRetry: 'Réessayer',
  crewRoutesWorker: 'Worker',
  crewRoutesPlanner: 'Planificateur',
  crewRoutesReviewer: 'Réviseur',
  crewRoutesRoute: '{role} · {provider} · {model} · {reasoningEffort}',
  crewRouteRepairAction: 'Changer de route',
  crewRouteRepairTitle: 'Changer la route d’un rôle Crew',
  crewRouteRepairDescription: 'Modifie uniquement le rôle sélectionné de cette session. La tâche échouée n’est pas relancée ; demandez ensuite au commandant de poursuivre le sous-agent d’origine.',
  crewRouteRepairRole: 'Rôle à modifier',
  crewRouteRepairProvider: 'Fournisseur',
  crewRouteRepairModel: 'Modèle',
  crewRouteRepairEffort: 'Niveau de raisonnement',
  crewRouteRepairCancel: 'Annuler',
  crewRouteRepairConfirm: 'Changer de route',
  crewRouteRepairLoading: 'Chargement des routes disponibles…',
  crewRouteRepairCatalogFailed: 'Impossible de charger les routes disponibles : {message}',
  crewRouteRepairPartial: 'Certains catalogues de fournisseurs n’ont pas pu être lus. Les routes disponibles restent sélectionnables.',
  crewRouteRepairFailed: 'Impossible de changer la route : {message}',
  nav: "Préréglages d'agent",

  setDefault: 'Définir comme nouvelle tâche par défaut',
  view: 'Afficher la configuration',

  presetStandardName: 'Mode standard',
  presetStandardDescription:
    'Travaillez avec du code, des fichiers et des informations. Convient à la plupart des tâches, avec recherche, édition, commandes de terminal et autres outils disponibles selon les besoins.',
  presetPtcName: 'Mode PTC',
  presetPtcDescription:
    'Inclut toutes les fonctionnalités du mode Standard. Mieux adapté aux tâches qui appellent des outils par lots, puis filtrent, organisent, dédupliquent, comptent ou résument les résultats.',
  presetMinimalName: 'Mode minimal',
  presetMinimalDescription:
    "L'agent utilise un terminal et une lecture d'image, avec compactage du contexte. Utile pour tester et comparer ses performances de base.",
  presetCordisName: 'Mode Créateur',
  presetCordisDescription:
    "Personnalisez DSH via la conversation. Laissez l'agent écrire des plugins qui ajoutent des fonctionnalités ou une interface utilisateur, ou combinez des outils et des invites pour créer votre propre mode.",
  presetCrewName: 'Crew',
  presetCrewDescription:
    'Crew réunit un commandant et trois rôles délégués : Worker pour l’implémentation, Planificateur pour la conception et Réviseur pour l’audit. Le commandant lit et divise la demande, délègue le travail, vérifie les livrables et rend compte. Il ne dispose ni d’un shell général ni d’un outil d’écriture du système de fichiers ; Worker réalise l’implémentation. Git utilise l’outil structuré crew_git et demande une confirmation avant toute écriture. Un mécanisme de protection sérialise les commandes de compilation et d’installation dans tout le processus. Utilisez le mode Plan intégré et ask_user_question.',

  inUse: 'Nouvelle tâche par défaut',

  noDescription: 'Aucune description.',
  brokenBadge: 'Échec du chargement',

  switchRefused: 'Impossible de passer à {name} : {reason}',
  standardUnavailable: "Le mode standard n'est pas disponible. Restaurez-le ou choisissez un autre mode disponible.",

  close: 'Fermer',

  creatorDraft: "Laissez l'agent m'aider à créer un préréglage",
  createPlugin: "Laissez l'agent créer un plugin",
  createPluginDescription: 'Entrez en mode Créateur et créez votre propre plugin DSH',
  createPluginChecking: 'Vérifier si le mode Créateur est disponible',
  createPluginUnavailable: 'Temporairement indisponible. Rouvrez ce menu pour réessayer',
  createPluginMissing: "Le mode Créateur n'est pas inclus dans cette configuration",

} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  ...guideDe,
  builtInGroup: 'Eingebaut', customGroup: 'Benutzerdefiniert',
  sectionIntro: 'Wählen Sie die Tools des Agenten und deren Funktionsweise aus. Verwenden Sie den Standardmodus für alltägliche Aufgaben oder den Creator-Modus, um DSH Funktionen hinzuzufügen.',

  seatHint: 'Wählen Sie die Agentenvoreinstellung für Ihre neue Aufgabe',
  headerHint: 'Die Agentenvoreinstellung, die beim Start dieser Aufgabe ausgewählt wurde',
  crewChoiceLabel: 'Kombination der Modelle',
  crewChoiceTriggerLabel: 'Kombination der Modelle: {name}',
  crewChoiceGone: 'Diese Kombination wird nicht mehr gespeichert. Wählen Sie eine andere.',
  crewChoiceIncomplete: 'Diese Kombination benennt nicht alle drei Rollen. Vervollständigen Sie sie in den Modell-Einstellungen.',
  crewChoiceUnserved: 'Diese Bereitstellung bietet keine Crew-Formation, daher kann die Kombination nicht angewendet werden.',
  crewChoiceRefused: 'Die Modellkombination konnte nicht angewendet werden: {reason}',
  crewChoiceConflict: 'Diese Sitzung führt bereits eine andere Modellkombination aus. Die Auswahl blieb für die nächste Crew-Sitzung erhalten.',
  crewChoiceConflictNamed: 'Diese Sitzung führt bereits „{recorded}“ aus. Die Auswahl blieb für die nächste Crew-Sitzung erhalten.',
  crewRoutesLoading: 'Crew · Kombination wird gelesen…',
  crewRoutesApplied: 'Crew · {name}',
  crewRoutesUnnamed: 'Unbenannte Kombination',
  crewRoutesUnapplied: 'Keine Kombination angewendet · Rollen nutzen ihre Vorgaben',
  crewRoutesUnappliedHint: 'Diese Sitzung hat keine Kombination aufgezeichnet, daher nutzen Worker, Planer und Reviewer jeweils ihre Standardroute.',
  crewRoutesUnavailable: 'Crew-Formation wird nicht bereitgestellt',
  crewRoutesUnavailableHint: 'Diese Bereitstellung bindet keine Crew-Formation ein, daher lässt sich die Kombination dieser Sitzung nicht lesen.',
  crewRoutesError: 'Crew-Kombination konnte nicht gelesen werden',
  crewRoutesErrorHint: 'Die Crew-Kombination dieser Sitzung konnte nicht gelesen werden: {message}',
  crewRoutesRetry: 'Erneut versuchen',
  crewRoutesWorker: 'Worker',
  crewRoutesPlanner: 'Planer',
  crewRoutesReviewer: 'Reviewer',
  crewRoutesRoute: '{role} · {provider} · {model} · {reasoningEffort}',
  crewRouteRepairAction: 'Route wechseln',
  crewRouteRepairTitle: 'Route einer Crew-Rolle wechseln',
  crewRouteRepairDescription: 'Ändert nur die ausgewählte Rolle dieser Sitzung. Die fehlgeschlagene Aufgabe wird nicht wiederholt; lass danach den ursprünglichen Subagenten durch den Commander fortsetzen.',
  crewRouteRepairRole: 'Zu wechselnde Rolle',
  crewRouteRepairProvider: 'Anbieter',
  crewRouteRepairModel: 'Modell',
  crewRouteRepairEffort: 'Reasoning-Stufe',
  crewRouteRepairCancel: 'Abbrechen',
  crewRouteRepairConfirm: 'Route wechseln',
  crewRouteRepairLoading: 'Verfügbare Routen werden geladen…',
  crewRouteRepairCatalogFailed: 'Verfügbare Routen konnten nicht geladen werden: {message}',
  crewRouteRepairPartial: 'Einige Anbieterkataloge konnten nicht gelesen werden. Verfügbare Routen bleiben auswählbar.',
  crewRouteRepairFailed: 'Route konnte nicht gewechselt werden: {message}',
  nav: 'Agentenvoreinstellungen',

  setDefault: 'Als Standard für neue Aufgabe festlegen',
  view: 'Konfiguration anzeigen',

  presetStandardName: 'Standardmodus',
  presetStandardDescription:
    'Arbeiten Sie mit Code, Dateien und Informationen. Geeignet für die meisten Aufgaben, da bei Bedarf Suche, Bearbeitung, Terminalbefehle und andere Tools verfügbar sind.',
  presetPtcName: 'PTC-Modus',
  presetPtcDescription:
    'Beinhaltet alle Funktionen des Standardmodus. Besser geeignet für Aufgaben, bei denen Tools stapelweise aufgerufen und die Ergebnisse dann gefiltert, organisiert, dedupliziert, gezählt oder zusammengefasst werden.',
  presetMinimalName: 'Minimalmodus',
  presetMinimalDescription:
    'Der Agent verwendet ein Terminal und das Lesen von Bildern mit Kontextkomprimierung. Nützlich zum Testen und Vergleichen der Grundleistung.',
  presetCordisName: 'Erstellermodus',
  presetCordisDescription:
    'Passen Sie DSH durch Gespräche an. Lassen Sie den Agenten Plugins schreiben, die Funktionen oder Benutzeroberflächen hinzufügen, oder kombinieren Sie Tools und Eingabeaufforderungen, um Ihren eigenen Modus zu erstellen.',
  presetCrewName: 'Crew',
  presetCrewDescription:
    'Crew verbindet einen Commander mit drei Delegationsrollen: Worker für die Implementierung, Planer für den Entwurf und Reviewer für die Prüfung. Der Commander liest und zerlegt die Anfrage, delegiert die Arbeit, prüft die Ergebnisse und berichtet. Er hat weder eine allgemeine Shell noch ein Schreibwerkzeug für das Dateisystem; die Implementierung übernimmt Worker. Git verwendet das strukturierte crew_git-Werkzeug und fragt vor Schreibvorgängen nach. Eine Schutzkomponente serialisiert Kompilier- und Installationsbefehle prozessweit. Verwenden Sie den integrierten Planmodus und ask_user_question.',

  inUse: 'Neuer Aufgabenstandard',

  noDescription: 'Keine Beschreibung.',
  brokenBadge: 'Laden fehlgeschlagen',

  switchRefused: 'Konnte nicht zu {name} wechseln: {reason}',
  standardUnavailable: 'Der Standardmodus ist nicht verfügbar. Stellen Sie es wieder her oder wählen Sie einen anderen verfügbaren Modus.',

  close: 'Schließen',

  creatorDraft: 'Lassen Sie sich vom Agenten beim Erstellen einer Voreinstellung helfen',
  createPlugin: 'Lassen Sie den Agenten ein Plugin erstellen',
  createPluginDescription: 'Wechseln Sie in den Erstellermodus und erstellen Sie Ihr eigenes DSH-Plugin',
  createPluginChecking: 'Prüfen, ob der Creator-Modus verfügbar ist',
  createPluginUnavailable: 'Vorübergehend nicht verfügbar. Öffnen Sie dieses Menü erneut, um es erneut zu versuchen',
  createPluginMissing: 'Der Creator-Modus ist in dieser Konfiguration nicht enthalten',

} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  ...guideRu,
  builtInGroup: 'Встроенный', customGroup: 'Пользовательский',
  sectionIntro: 'Выбирайте инструменты агента и то, как они работают. Используйте стандартный режим для повседневных задач или режим Creator, чтобы расширить возможности DSH.',

  seatHint: 'Выберите предустановку агента для вашей новой задачи',
  headerHint: 'Предварительная настройка агента, выбранная при запуске этой задачи',
  crewChoiceLabel: 'Комбинация моделей',
  crewChoiceTriggerLabel: 'Комбинация моделей: {name}',
  crewChoiceGone: 'Эта комбинация больше не сохранена. Выберите другую.',
  crewChoiceIncomplete: 'В этой комбинации указаны не все три роли. Дополните её в настройках моделей.',
  crewChoiceUnserved: 'Это развёртывание не предоставляет crew-формацию, поэтому комбинацию нельзя применить.',
  crewChoiceRefused: 'Не удалось применить комбинацию моделей: {reason}',
  crewChoiceConflict: 'Эта сессия уже работает на другой комбинации моделей. Выбор сохранён для следующей сессии Crew.',
  crewChoiceConflictNamed: 'Эта сессия уже работает на «{recorded}». Выбор сохранён для следующей сессии Crew.',
  crewRoutesLoading: 'Crew · чтение комбинации…',
  crewRoutesApplied: 'Crew · {name}',
  crewRoutesUnnamed: 'Комбинация без имени',
  crewRoutesUnapplied: 'Комбинация не применена · роли используют значения по умолчанию',
  crewRoutesUnappliedHint: 'Эта сессия не записала комбинацию, поэтому воркер, планировщик и рецензент используют собственные маршруты по умолчанию.',
  crewRoutesUnavailable: 'Формирование Crew не предоставлено',
  crewRoutesUnavailableHint: 'В этом развёртывании нет формирования Crew, поэтому комбинацию этой сессии прочитать нельзя.',
  crewRoutesError: 'Не удалось прочитать комбинацию Crew',
  crewRoutesErrorHint: 'Не удалось прочитать комбинацию Crew этой сессии: {message}',
  crewRoutesRetry: 'Повторить',
  crewRoutesWorker: 'Воркер',
  crewRoutesPlanner: 'Планировщик',
  crewRoutesReviewer: 'Рецензент',
  crewRoutesRoute: '{role} · {provider} · {model} · {reasoningEffort}',
  crewRouteRepairAction: 'Сменить маршрут',
  crewRouteRepairTitle: 'Сменить маршрут роли Crew',
  crewRouteRepairDescription: 'Меняет только выбранную роль этой сессии и не перезапускает неудачную задачу. После смены попросите командира продолжить исходный субагент.',
  crewRouteRepairRole: 'Изменяемая роль',
  crewRouteRepairProvider: 'Провайдер',
  crewRouteRepairModel: 'Модель',
  crewRouteRepairEffort: 'Уровень рассуждения',
  crewRouteRepairCancel: 'Отмена',
  crewRouteRepairConfirm: 'Сменить маршрут',
  crewRouteRepairLoading: 'Загрузка доступных маршрутов…',
  crewRouteRepairCatalogFailed: 'Не удалось загрузить доступные маршруты: {message}',
  crewRouteRepairPartial: 'Некоторые каталоги провайдеров не прочитаны. Доступные маршруты можно выбрать.',
  crewRouteRepairFailed: 'Не удалось сменить маршрут: {message}',
  nav: 'Настройки агента',

  setDefault: 'Установить в качестве новой задачи по умолчанию',
  view: 'Посмотреть конфигурацию',

  presetStandardName: 'Стандартный режим',
  presetStandardDescription:
    'Работайте с кодом, файлами и информацией. Подходит для большинства задач, с поиском, редактированием, командами терминала и другими инструментами, доступными по мере необходимости.',
  presetPtcName: 'Режим PTC',
  presetPtcDescription:
    'Включает все возможности стандартного режима. Лучше подходит для задач, которые вызывают инструменты в пакетном режиме, а затем фильтруют, организуют, дедуплицируют, подсчитывают или суммируют результаты.',
  presetMinimalName: 'Минимальный режим',
  presetMinimalDescription:
    'Агент использует терминал и чтение изображений со сжатием контекста. Полезно для тестирования и сравнения его базовой производительности.',
  presetCordisName: 'Режим автора',
  presetCordisDescription:
    'Настройте DSH через разговор. Позвольте агенту писать плагины, которые добавляют функции или пользовательский интерфейс, или комбинируйте инструменты и подсказки для создания собственного режима.',
  presetCrewName: 'Crew',
  presetCrewDescription:
    'Crew объединяет командира и три делегированные роли: Воркер для реализации, Планировщик для проектирования и Рецензент для аудита. Командир читает и разделяет запрос, делегирует работу, проверяет результаты и сообщает о них. У него нет общей оболочки или инструмента записи в файловую систему; реализацию выполняет Воркер. Git использует структурированный инструмент crew_git и запрашивает подтверждение перед записью. Защитный механизм сериализует команды компиляции и установки в пределах всего процесса. Используйте встроенный режим плана и ask_user_question.',

  inUse: 'Новая задача по умолчанию',

  noDescription: 'Нет описания.',
  brokenBadge: 'Не удалось загрузить',

  switchRefused: 'Не удалось переключиться на {name}: {reason}',
  standardUnavailable: 'Стандартный режим недоступен. Восстановите его или выберите другой доступный режим.',

  close: 'Закрыть',

  creatorDraft: 'Позвольте агенту помочь мне создать пресет',
  createPlugin: 'Позвольте агенту создать плагин',
  createPluginDescription: 'Войдите в режим Creator и создайте свой собственный плагин DSH.',
  createPluginChecking: 'Проверка доступности режима Creator',
  createPluginUnavailable: 'Временно недоступен. Откройте это меню еще раз, чтобы повторить попытку.',
  createPluginMissing: 'Режим Creator не включен в эту конфигурацию.',

} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  ...guidePt,
  builtInGroup: 'Integrado', customGroup: 'Personalizado',
  sectionIntro: 'Escolha as ferramentas do agente e como funciona. Use o modo Padrão para tarefas diárias ou o modo Criador para adicionar recursos ao DSH.',

  seatHint: 'Escolha a predefinição de agente para sua nova tarefa',
  headerHint: 'A predefinição do agente escolhida quando esta tarefa foi iniciada',
  crewChoiceLabel: 'Combinação de modelos',
  crewChoiceTriggerLabel: 'Combinação de modelos: {name}',
  crewChoiceGone: 'Essa combinação não está mais guardada. Escolha outra.',
  crewChoiceIncomplete: 'Essa combinação não nomeia as três funções. Complete-a nas configurações de Modelos.',
  crewChoiceUnserved: 'Esta implantação não oferece formação de crew, então a combinação não pode ser aplicada.',
  crewChoiceRefused: 'Não foi possível aplicar a combinação de modelos: {reason}',
  crewChoiceConflict: 'Esta sessão já executa outra combinação de modelos. A escolha foi mantida para a próxima sessão de crew.',
  crewChoiceConflictNamed: 'Esta sessão já executa “{recorded}”. A escolha foi mantida para a próxima sessão de crew.',
  crewRoutesLoading: 'Crew · lendo a combinação…',
  crewRoutesApplied: 'Crew · {name}',
  crewRoutesUnnamed: 'Combinação sem nome',
  crewRoutesUnapplied: 'Nenhuma combinação aplicada · as funções usam os padrões',
  crewRoutesUnappliedHint: 'Esta sessão não registrou nenhuma combinação, então o worker, o planejador e o revisor usam cada um sua rota padrão.',
  crewRoutesUnavailable: 'A formação de crew não é fornecida',
  crewRoutesUnavailableHint: 'Esta implantação não monta a formação de crew, então a combinação desta sessão não pode ser lida.',
  crewRoutesError: 'Não foi possível ler a combinação Crew',
  crewRoutesErrorHint: 'Não foi possível ler a combinação Crew desta sessão: {message}',
  crewRoutesRetry: 'Tentar novamente',
  crewRoutesWorker: 'Worker',
  crewRoutesPlanner: 'Planejador',
  crewRoutesReviewer: 'Revisor',
  crewRoutesRoute: '{role} · {provider} · {model} · {reasoningEffort}',
  crewRouteRepairAction: 'Trocar rota',
  crewRouteRepairTitle: 'Trocar a rota de um papel do Crew',
  crewRouteRepairDescription: 'Altera apenas o papel selecionado desta sessão e não repete a tarefa que falhou. Depois, peça ao comandante para continuar o subagente original.',
  crewRouteRepairRole: 'Papel a alterar',
  crewRouteRepairProvider: 'Provedor',
  crewRouteRepairModel: 'Modelo',
  crewRouteRepairEffort: 'Nível de raciocínio',
  crewRouteRepairCancel: 'Cancelar',
  crewRouteRepairConfirm: 'Trocar rota',
  crewRouteRepairLoading: 'Carregando rotas disponíveis…',
  crewRouteRepairCatalogFailed: 'Não foi possível carregar as rotas disponíveis: {message}',
  crewRouteRepairPartial: 'Alguns catálogos de provedores não puderam ser lidos. As rotas disponíveis continuam selecionáveis.',
  crewRouteRepairFailed: 'Não foi possível trocar a rota: {message}',
  nav: 'Predefinições de agente',

  setDefault: 'Definir como nova tarefa padrão',
  view: 'Ver configuração',

  presetStandardName: 'Modo padrão',
  presetStandardDescription:
    'Trabalhe com código, arquivos e informações. Adequado para a maioria das tarefas, com pesquisa, edição, comandos de terminal e outras ferramentas disponíveis conforme necessário.',
  presetPtcName: 'modo PTC',
  presetPtcDescription:
    'Inclui todos os recursos do modo Padrão. Mais adequado para tarefas que chamam ferramentas em lotes e depois filtram, organizam, desduplicam, contam ou resumem os resultados.',
  presetMinimalName: 'Modo mínimo',
  presetMinimalDescription:
    'O agente utiliza terminal e leitura de imagens, com compactação de contexto. Útil para testar e comparar seu desempenho básico.',
  presetCordisName: 'Modo criador',
  presetCordisDescription:
    'Personalize DSH por meio de conversa. Deixe o agente escrever plug-ins que adicionem recursos ou UI, ou combine ferramentas e prompts para criar seu próprio modo.',
  presetCrewName: 'Crew',
  presetCrewDescription:
    'Crew reúne um comandante e três funções delegadas: Worker para implementação, Planejador para design e Revisor para auditoria. O comandante lê e divide o pedido, delega o trabalho, verifica as entregas e relata. Ele não tem shell geral nem ferramenta de escrita no sistema de arquivos; Worker realiza a implementação. O Git usa a ferramenta estruturada crew_git e pede confirmação antes de gravar. Um mecanismo de proteção serializa os comandos de compilação e instalação em todo o processo. Use o modo de plano integrado e ask_user_question.',

  inUse: 'Novo padrão de tarefa',

  noDescription: 'Nenhuma descrição.',
  brokenBadge: 'Falha ao carregar',

  switchRefused: 'Não foi possível mudar para {name}: {reason}',
  standardUnavailable: 'O modo padrão não está disponível. Restaure-o ou escolha outro modo disponível.',

  close: 'Fechar',

  creatorDraft: 'Deixe o agente me ajudar a criar uma predefinição',
  createPlugin: 'Deixe o agente criar um plugin',
  createPluginDescription: 'Entre no modo Criador e crie seu próprio plug-in DSH',
  createPluginChecking: 'Verificando se o modo Criador está disponível',
  createPluginUnavailable: 'Temporariamente indisponível. Reabra este menu para tentar novamente',
  createPluginMissing: 'O modo criador não está incluído nesta configuração',

} satisfies Record<keyof typeof en, string>
