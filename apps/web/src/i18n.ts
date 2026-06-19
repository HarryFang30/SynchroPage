import type { Language } from "./settings";

export type AppCopy = {
  common: {
    assistant: string;
    selectedContent: string;
    image: string;
    ready: string;
    aligned: string;
    none: string;
    listSeparator: string;
    sentenceSeparator: string;
    sourcePdfPage: (pageNo: number | string) => string;
    explanationProgress: (current: number, total: number) => string;
    pageCount: (count: number) => string;
    readyCount: (count: number) => string;
    pageLabel: (pageNo: number | string) => string;
  };
  settings: {
    close: string;
    navAria: string;
    description: string;
    sections: {
      general: string;
      appearance: string;
      agent: string;
      pdf: string;
      account: string;
      storage: string;
      advanced: string;
    };
    general: {
      languageLabel: string;
      languageDescription: string;
      chinese: string;
      english: string;
      savePreferencesLabel: string;
      savePreferencesDescription: string;
      resetLayoutLabel: string;
      resetLayoutDescription: string;
      resetLayoutButton: string;
    };
    appearance: {
      themeLabel: string;
      themeDescription: string;
      themeSystem: string;
      themeLight: string;
      themeDark: string;
      accentLabel: string;
      accentDescription: string;
      accentClay: string;
      accentGraphite: string;
      accentSage: string;
      pdfBackgroundLabel: string;
      pdfBackgroundDescription: string;
      pdfBackgroundPaper: string;
      pdfBackgroundPlain: string;
      pdfBackgroundSoft: string;
      fontScaleLabel: string;
      fontScaleDescription: string;
      fontCompact: string;
      fontDefault: string;
      fontLarge: string;
      compactModeLabel: string;
      compactModeDescription: string;
    };
    agent: {
      sourcePillsLabel: string;
      sourcePillsDescription: string;
      pageSuggestionsLabel: string;
      pageSuggestionsDescription: string;
      pdfContextFullPageLimitLabel: string;
      pdfContextFullPageLimitDescription: string;
      pdfContextEdgePageCountLabel: string;
      pdfContextEdgePageCountDescription: string;
    };
    pdf: {
      scrollbarLabel: string;
      scrollbarDescription: string;
      scrollbarThin: string;
      scrollbarSubtle: string;
      scrollbarNative: string;
      summaryHintLabel: string;
      summaryHintDescription: string;
    };
    account: {
      oauthStatusLabel: string;
      oauthStatusDescription: string;
      connectedEmailLabel: string;
      connectedEmailDescription: string;
      providerStatusLabel: string;
      reconnectLabel: string;
      reconnectDescription: string;
      disconnectButton: string;
      connectButton: string;
      notConnected: string;
      statuses: {
        connected: string;
        polling: string;
        offline: string;
        mock: string;
        ready: string;
        unknown: string;
      };
    };
    storage: {
      saveStateLabel: string;
      saveStateDescription: string;
      workspaceCountLabel: string;
      workspaceCountDescription: string;
      documentCountLabel: string;
      documentCountDescription: string;
      usageLabel: string;
      usageDescription: string;
      persistentLabel: string;
      persistentDescription: string;
      persistentRequestButton: string;
      exportLabel: string;
      exportDescription: string;
      exportButton: string;
      importLabel: string;
      importDescription: string;
      importButton: string;
      clearLabel: string;
      clearDescription: string;
      clearButton: string;
      repairLabel: string;
      repairDescription: string;
      repairButton: string;
      resetLabel: string;
      resetDescription: string;
      resetButton: string;
      persisted: string;
      bestEffort: string;
      unsupported: string;
      unknown: string;
      noWorkspace: string;
    };
    confirm: {
      cancel: string;
      clearWorkspaceTitle: string;
      clearWorkspaceDescription: string;
      clearWorkspaceConfirm: string;
      resetWorkspaceTitle: string;
      resetWorkspaceDescription: string;
      resetWorkspaceConfirm: string;
      disconnectTitle: string;
      disconnectDescription: string;
      disconnectConfirm: string;
      resetPreferencesTitle: string;
      resetPreferencesDescription: string;
      resetPreferencesConfirm: string;
    };
    advanced: {
      debugLabel: string;
      debugDescription: string;
      clearPreferencesLabel: string;
      clearPreferencesDescription: string;
      clearPreferencesButton: string;
      diagnosticsLabel: string;
      diagnosticsHiddenDescription: string;
      visible: string;
      hidden: string;
    };
  };
  status: {
    localPrototype: string;
    preferencesReset: string;
    noSelection: string;
    selectionAdded: string;
    explainingSelection: string;
    summarizingSelection: string;
    codeCopied: (code: string) => string;
    enterCode: (code: string) => string;
    oauthCanceled: string;
    oauthDisconnected: string;
    codeShown: (code: string) => string;
    codeExpired: string;
    oauthConnected: string;
    oauthBackendMock: string;
    jsonImported: string;
    layoutReset: string;
    generationQueued: string;
  };
  errors: {
    accountNotFound: string;
    jsonNeedsPages: string;
    emptyGatewayResult: string;
    generationStopped: string;
    imageReadFailed: string;
    importedDocument: string;
    importedPageTitle: (index: number) => string;
  };
  auth: {
    gatewayConnected: (account: string | null) => string;
    gatewayWaiting: string;
    gatewayOffline: string;
    gatewayDisconnected: string;
    connectionConnected: string;
    connectionWaiting: string;
    connectionLocal: string;
    connectionReady: string;
  };
  persistence: {
    saving: string;
    saved: string;
    failed: string;
    quota: string;
    localDraft: string;
    restored: string;
    pdfMissing: string;
    restoreFailed: string;
    retrySave: string;
    saveStatusLabel: string;
    uploadSaved: string;
    workspaceCleared: string;
    workspaceExported: string;
    workspaceImported: string;
    persistentEnabled: string;
    persistentUnavailable: string;
    storageRepaired: (count: number) => string;
  };
  topbar: {
    resizeHandle: string;
    layoutSwitcherAria: string;
    restoreWorkbench: string;
    hideRail: string;
    showRail: string;
    hideNotes: string;
    showNotes: string;
    hideAgent: string;
    showAgent: string;
    exitPdfFocus: string;
    pdfOnly: string;
    uploadPdf: string;
    openSettings: string;
    moreActions: string;
    viewOpenAiCode: string;
    connectOpenAi: string;
    importJson: string;
    exportJson: string;
    advancedSettings: string;
    generate: string;
    pageProgressAria: string;
  };
  rail: {
    searchPlaceholder: string;
    documents: string;
    currentWorkspace: string;
    uploadDocument: string;
    emptyDocuments: string;
    activeDocument: string;
    missingFile: string;
    documentCount: (count: number) => string;
    documentMeta: (pageCount: number, generatedCount: number) => string;
    currentPage: (pageNo: number) => string;
  };
  pdf: {
    samplePdfPage: string;
    previousPage: string;
    nextPage: string;
    previewTitle: string;
    renderFailed: string;
    loading: string;
  };
  notes: {
    title: string;
    tabNotes: string;
    tabStructure: string;
    tabJson: string;
  };
  agent: {
    addImage: string;
    clearContext: string;
    newConversation: string;
    removeContext: string;
    removeImage: string;
    contextFormula: (pageNo: number) => string;
    contextSelection: (pageNo: number) => string;
    contextPdfReference: (pageNo: number) => string;
    contextSource: (pageNo: number, source: string) => string;
    selectedPdfPage: (pageNo: number | string) => string;
    selectedNotesPage: (pageNo: number | string) => string;
    assistantMessage: string;
    pageSource: (pageNo: number | string) => string;
    imagePreview: (name: string) => string;
    selectedFallbackSuggestions: string[];
    pageSuggestions: (title: string, concept: string) => string[];
    quickExplainPrompt: (label: string) => string;
    quickSummarizePrompt: (label: string) => string;
    continuePrompt: string;
    localPreviewIntro: string;
    localPreviewSelected: (title: string) => string;
    localPreviewContexts: (count: number) => string;
    localPreviewPage: (pageNo: number) => string;
    localPreviewImages: (count: number) => string;
    localPreviewQuestion: (question: string) => string;
    selectionSources: {
      pdfPage: string;
      notes: string;
      assistant: string;
      rail: string;
      page: string;
    };
    askCurrentPage: string;
    quoteLabel: string;
    edit: string;
    generationStopped: string;
    generationFailed: string;
    copy: string;
    regenerate: string;
    askWithSelectionPlaceholder: string;
    askPlaceholder: string;
    inputAria: string;
    formulaTitle: string;
    stop: string;
    send: string;
    thinking: string;
    removeSelectedContent: string;
    selectionToolbarAria: string;
    addToConversation: string;
    explainSelection: string;
    summarizeSelection: string;
  };
  oauth: {
    kicker: string;
    title: string;
    cancel: string;
    codeAria: (code: string) => string;
    copied: string;
    copyCode: string;
    openAuthPage: string;
    expiresIn: (time: string) => string;
  };
  structure: {
    pageNo: string;
    parser: string;
    ocr: string;
    confidence: string;
    prerequisites: string;
    visualNotes: string;
    sourceText: string;
    ocrEnabled: string;
    ocrDisabled: string;
  };
};

const zhCN: AppCopy = {
  common: {
    assistant: "助手",
    selectedContent: "选中内容",
    image: "图片",
    ready: "已就绪",
    aligned: "已对齐",
    none: "无",
    listSeparator: "、",
    sentenceSeparator: "；",
    sourcePdfPage: (pageNo) => `来源 PDF p.${pageNo}`,
    explanationProgress: (current, total) => `讲解 ${current} / ${total}`,
    pageCount: (count) => `${count} 页`,
    readyCount: (count) => `${count} 已就绪`,
    pageLabel: (pageNo) => `第 ${pageNo} 页`,
  },
  settings: {
    close: "关闭设置",
    navAria: "设置分区",
    description: "管理低频配置，保持阅读工作区干净。",
    sections: {
      general: "通用",
      appearance: "外观",
      agent: "助手",
      pdf: "PDF 阅读器",
      account: "账户 / 网关",
      storage: "存储",
      advanced: "高级",
    },
    general: {
      languageLabel: "界面语言",
      languageDescription: "切换 PagePair Reader 的固定界面文案。",
      chinese: "中文",
      english: "English",
      savePreferencesLabel: "保存界面偏好",
      savePreferencesDescription: "在本机保存主题、密度和面板显示相关偏好。关闭后，本页修改只在当前会话生效。",
      resetLayoutLabel: "重置界面布局",
      resetLayoutDescription: "恢复目录、讲解和助手面板。",
      resetLayoutButton: "重置布局",
    },
    appearance: {
      themeLabel: "主题",
      themeDescription: "切换 Claude-like 浅色、深色，或跟随系统外观。",
      themeSystem: "跟随系统",
      themeLight: "浅色",
      themeDark: "深色",
      accentLabel: "强调色",
      accentDescription: "切换工作区的强调色 token。",
      accentClay: "陶土色",
      accentGraphite: "石墨灰",
      accentSage: "鼠尾草绿",
      pdfBackgroundLabel: "PDF 背景",
      pdfBackgroundDescription: "调整文档背后的低噪声底色。",
      pdfBackgroundPaper: "纸张",
      pdfBackgroundPlain: "纯净",
      pdfBackgroundSoft: "柔和",
      fontScaleLabel: "字体大小",
      fontScaleDescription: "应用于讲解、助手输出和阅读文本。",
      fontCompact: "紧凑",
      fontDefault: "默认",
      fontLarge: "偏大",
      compactModeLabel: "紧凑模式",
      compactModeDescription: "减少 toolbar 和 pane 的间距。",
    },
    agent: {
      sourcePillsLabel: "显示来源 pill",
      sourcePillsDescription: "在对话上方显示紧凑来源上下文。",
      pageSuggestionsLabel: "页面感知建议",
      pageSuggestionsDescription: "根据当前页标题和概念生成空状态提示。",
      pdfContextFullPageLimitLabel: "全文上下文页数阈值",
      pdfContextFullPageLimitDescription: "PDF 页数不超过这个值时，发送全部可提取文本给模型。",
      pdfContextEdgePageCountLabel: "长 PDF 前后截取页数",
      pdfContextEdgePageCountDescription: "超过阈值时，分别截取开头和结尾的页数作为 PDF 上下文。",
    },
    pdf: {
      scrollbarLabel: "滚动条样式",
      scrollbarDescription: "应用于工作区滚动容器。",
      scrollbarThin: "细",
      scrollbarSubtle: "更弱",
      scrollbarNative: "系统默认",
      summaryHintLabel: "显示页面摘要提示",
      summaryHintDescription: "在文档下方显示低噪声上下文提示。",
    },
    account: {
      oauthStatusLabel: "OAuth 状态",
      oauthStatusDescription: "OpenAI Gateway 连接状态。",
      connectedEmailLabel: "已连接邮箱",
      connectedEmailDescription: "只在这里显示，不出现在主界面状态栏。",
      providerStatusLabel: "Provider 状态",
      reconnectLabel: "重新连接 / 退出",
      reconnectDescription: "复用现有 OAuth start/logout 流程。",
      disconnectButton: "退出登录",
      connectButton: "连接 OpenAI",
      notConnected: "未连接",
      statuses: {
        connected: "已连接",
        polling: "等待设备验证码",
        offline: "后端未启动",
        mock: "本地预览",
        ready: "可连接",
        unknown: "检查中",
      },
    },
    storage: {
      saveStateLabel: "保存状态",
      saveStateDescription: "当前工作区的本地自动保存状态。",
      workspaceCountLabel: "工作区数量",
      workspaceCountDescription: "本机保存的阅读工作区。",
      documentCountLabel: "文档数量",
      documentCountDescription: "本机保存的 PDF 与讲解文档。",
      usageLabel: "本地存储占用",
      usageDescription: "浏览器报告的站点存储估算值。",
      persistentLabel: "持久存储",
      persistentDescription: "请求浏览器尽量不要在存储压力下清理本地草稿。",
      persistentRequestButton: "启用持久存储",
      exportLabel: "导出当前工作区",
      exportDescription: "导出 PDF、讲解、对话和本地元数据，便于备份。",
      exportButton: "导出",
      importLabel: "导入工作区",
      importDescription: "导入 PagePair 工作区备份并打开。",
      importButton: "导入",
      clearLabel: "清空当前工作区",
      clearDescription: "删除当前 PDF、讲解、对话和选区上下文。",
      clearButton: "清空",
      repairLabel: "检查并清理存储",
      repairDescription: "检查无引用数据并修复损坏引用。",
      repairButton: "检查清理",
      resetLabel: "重置当前工作区",
      resetDescription: "回到初始示例状态，并保留全局 UI 偏好。",
      resetButton: "重置",
      persisted: "已启用",
      bestEffort: "标准存储",
      unsupported: "浏览器不支持",
      unknown: "未知",
      noWorkspace: "暂无工作区",
    },
    confirm: {
      cancel: "取消",
      clearWorkspaceTitle: "清空当前工作区？",
      clearWorkspaceDescription: "这会删除当前 PDF、生成讲解、对话和选区上下文。此操作无法撤销。",
      clearWorkspaceConfirm: "清空",
      resetWorkspaceTitle: "重置当前工作区？",
      resetWorkspaceDescription: "这会移除当前工作区并回到初始示例状态。已保存的 PDF、讲解和对话将被删除。",
      resetWorkspaceConfirm: "重置",
      disconnectTitle: "断开 OpenAI OAuth？",
      disconnectDescription: "断开后，新的 AI 请求将无法继续使用当前 OAuth 会话，直到你重新连接。",
      disconnectConfirm: "断开连接",
      resetPreferencesTitle: "重置本地 UI 偏好？",
      resetPreferencesDescription: "这只会恢复主题、布局和界面偏好，不会删除 PDF、讲解或对话。",
      resetPreferencesConfirm: "重置偏好",
    },
    advanced: {
      debugLabel: "Debug 模式",
      debugDescription: "在低噪声 footer 中显示任务状态和诊断信息。",
      clearPreferencesLabel: "清除本地 UI 偏好",
      clearPreferencesDescription: "只重置本地视觉偏好。",
      clearPreferencesButton: "重置偏好",
      diagnosticsLabel: "开发者诊断",
      diagnosticsHiddenDescription: "开启 Debug 模式后显示运行状态。",
      visible: "可见",
      hidden: "隐藏",
    },
  },
  status: {
    localPrototype: "本地原型",
    preferencesReset: "本地 UI 设置已重置",
    noSelection: "没有可加入的页面选区",
    selectionAdded: "选中内容已加入对话",
    explainingSelection: "正在解释选中内容",
    summarizingSelection: "正在总结选中内容",
    codeCopied: (code) => `授权码 ${code} 已复制`,
    enterCode: (code) => `请在 OpenAI 页面输入授权码 ${code}`,
    oauthCanceled: "OAuth 登录已取消",
    oauthDisconnected: "OAuth 会话已断开",
    codeShown: (code) => `授权码 ${code} 已显示，复制后打开授权页`,
    codeExpired: "OAuth 授权码已过期",
    oauthConnected: "OAuth 已连接",
    oauthBackendMock: "OAuth 后端未启动，已进入静态模拟连接",
    jsonImported: "已导入 PagePair JSON",
    layoutReset: "工作区布局已重置",
    generationQueued: "生成任务已交给后端 harness",
  },
  errors: {
    accountNotFound: "请先连接 OpenAI OAuth 后再发送。",
    jsonNeedsPages: "JSON 需要包含 pages 数组",
    emptyGatewayResult: "AI 网关返回了空结果",
    generationStopped: "生成已停止",
    imageReadFailed: "图片读取失败",
    importedDocument: "导入文档",
    importedPageTitle: (index) => `第 ${index + 1} 页讲解`,
  },
  auth: {
    gatewayConnected: (account) => `OpenAI Gateway：OAuth 会话已连接${account ? ` · ${account}` : ""}`,
    gatewayWaiting: "OpenAI Gateway：等待授权",
    gatewayOffline: "OpenAI Gateway：后端未启动",
    gatewayDisconnected: "OpenAI Gateway：未连接",
    connectionConnected: "OAuth 已连接",
    connectionWaiting: "等待验证码",
    connectionLocal: "本地预览",
    connectionReady: "网关就绪",
  },
  persistence: {
    saving: "正在保存...",
    saved: "已保存",
    failed: "保存失败，点击重试",
    quota: "存储空间不足",
    localDraft: "本地草稿",
    restored: "已恢复本地 workspace",
    pdfMissing: "PDF 文件缺失，metadata 已恢复",
    restoreFailed: "恢复 workspace 失败",
    retrySave: "重试保存",
    saveStatusLabel: "保存状态",
    uploadSaved: "PDF 已保存到本机",
    workspaceCleared: "本地 workspace 已清空",
    workspaceExported: "workspace 已导出",
    workspaceImported: "workspace 已导入",
    persistentEnabled: "浏览器已启用持久存储",
    persistentUnavailable: "浏览器未授予持久存储，将继续使用普通本地保存",
    storageRepaired: (count) => `存储检查完成，处理 ${count} 条异常记录`,
  },
  topbar: {
    resizeHandle: "调整面板宽度",
    layoutSwitcherAria: "工作区布局",
    restoreWorkbench: "恢复完整工作台",
    hideRail: "隐藏左侧目录",
    showRail: "显示左侧目录",
    hideNotes: "隐藏讲解面板",
    showNotes: "显示讲解面板",
    hideAgent: "隐藏助手",
    showAgent: "显示助手",
    exitPdfFocus: "退出 PDF 专注",
    pdfOnly: "只看 PDF",
    uploadPdf: "上传 PDF",
    openSettings: "打开设置",
    moreActions: "更多操作",
    viewOpenAiCode: "查看 OpenAI 验证码",
    connectOpenAi: "连接 OpenAI OAuth",
    importJson: "导入 PagePair JSON",
    exportJson: "导出 JSON",
    advancedSettings: "高级设置",
    generate: "生成",
    pageProgressAria: "页面进度",
  },
  rail: {
    searchPlaceholder: "搜索文档 / PDF",
    documents: "文档",
    currentWorkspace: "当前工作区",
    uploadDocument: "上传 PDF",
    emptyDocuments: "没有匹配的文档",
    activeDocument: "当前",
    missingFile: "文件缺失",
    documentCount: (count) => `${count} 个文档`,
    documentMeta: (pageCount, generatedCount) => `${pageCount} 页 · ${generatedCount} 页讲解`,
    currentPage: (pageNo) => `停在第 ${pageNo} 页`,
  },
  pdf: {
    samplePdfPage: "示例 PDF 页面",
    previousPage: "上一页",
    nextPage: "下一页",
    previewTitle: "PDF 预览",
    renderFailed: "PDF 页面渲染失败，已回退到浏览器预览。",
    loading: "正在加载 PDF 页面",
  },
  notes: {
    title: "结构化讲解",
    tabNotes: "讲解",
    tabStructure: "结构",
    tabJson: "JSON",
  },
  agent: {
    addImage: "加入图片",
    clearContext: "清空上下文",
    newConversation: "新对话",
    removeContext: "移除上下文",
    removeImage: "移除图片",
    contextFormula: (pageNo) => `公式 · PDF p.${pageNo}`,
    contextSelection: (pageNo) => `选中内容 · PDF p.${pageNo}`,
    contextPdfReference: (pageNo) => `PDF 来源 · p.${pageNo}`,
    contextSource: (pageNo, source) => `来源 PDF p.${pageNo} · ${source}`,
    selectedPdfPage: (pageNo) => `来源 PDF p.${pageNo}`,
    selectedNotesPage: (pageNo) => `讲解 p.${pageNo}`,
    assistantMessage: "助手消息",
    pageSource: (pageNo) => `页面 p.${pageNo}`,
    imagePreview: (name) => `图片 · ${name}`,
    selectedFallbackSuggestions: ["解释当前页的核心内容", "总结本页关键知识点", "用例子讲清楚这一页", "根据本页内容出几道题"],
    pageSuggestions: () => ["解释当前页的核心内容", "总结本页关键知识点", "用例子讲清楚这一页", "根据本页内容出几道题"],
    quickExplainPrompt: (label) => `请解释这段选中内容，优先基于该来源回答：${label}`,
    quickSummarizePrompt: (label) => `请总结这段选中内容，提炼关键概念和可能的公式关系：${label}`,
    continuePrompt: "请根据上下文继续。",
    localPreviewIntro: "本地预览回复：真实回答会通过后端 `/api/agent/chat` 使用 OpenAI OAuth 发送。",
    localPreviewSelected: (title) => `已读取选中内容：${title}。`,
    localPreviewContexts: (count) => `已读取 ${count} 段上下文。`,
    localPreviewPage: (pageNo) => `已读取第 ${pageNo} 页。`,
    localPreviewImages: (count) => `同时包含 ${count} 张图片。`,
    localPreviewQuestion: (question) => `你的问题：${question}`,
    selectionSources: {
      pdfPage: "PDF 页面选区",
      notes: "讲解区选区",
      assistant: "助手消息选区",
      rail: "目录选区",
      page: "页面选区",
    },
    askCurrentPage: "询问当前页面",
    quoteLabel: "选中内容",
    edit: "编辑",
    generationStopped: "生成已停止",
    generationFailed: "生成失败，请重试",
    copy: "复制",
    regenerate: "重新生成",
    askWithSelectionPlaceholder: "基于选中内容提问",
    askPlaceholder: "询问当前页面或选中内容",
    inputAria: "助手输入框",
    formulaTitle: "数学公式",
    stop: "停止",
    send: "发送",
    thinking: "正在基于当前上下文思考",
    removeSelectedContent: "移除选中内容",
    selectionToolbarAria: "选中内容操作",
    addToConversation: "添加到对话",
    explainSelection: "解释选中内容",
    summarizeSelection: "总结选中内容",
  },
  oauth: {
    kicker: "OpenAI Codex 登录",
    title: "输入网页要求的 9 位验证码",
    cancel: "取消 OAuth 登录",
    codeAria: (code) => `授权码 ${code}`,
    copied: "已复制",
    copyCode: "复制验证码",
    openAuthPage: "打开授权页",
    expiresIn: (time) => `${time} 后过期`,
  },
  structure: {
    pageNo: "页号",
    parser: "解析器",
    ocr: "OCR",
    confidence: "对齐置信度",
    prerequisites: "前置概念",
    visualNotes: "图表说明",
    sourceText: "解析文本",
    ocrEnabled: "已启用",
    ocrDisabled: "未启用",
  },
};

const enUS: AppCopy = {
  common: {
    assistant: "Assistant",
    selectedContent: "Selected content",
    image: "Image",
    ready: "Ready",
    aligned: "Aligned",
    none: "None",
    listSeparator: ", ",
    sentenceSeparator: "; ",
    sourcePdfPage: (pageNo) => `Source PDF p.${pageNo}`,
    explanationProgress: (current, total) => `Notes ${current} / ${total}`,
    pageCount: (count) => `${count} ${count === 1 ? "page" : "pages"}`,
    readyCount: (count) => `${count} ready`,
    pageLabel: (pageNo) => `Page ${pageNo}`,
  },
  settings: {
    close: "Close settings",
    navAria: "Settings sections",
    description: "Manage low-frequency options without cluttering the reading workspace.",
    sections: {
      general: "General",
      appearance: "Appearance",
      agent: "Assistant",
      pdf: "PDF Reader",
      account: "Account / Gateway",
      storage: "Storage",
      advanced: "Advanced",
    },
    general: {
      languageLabel: "Interface language",
      languageDescription: "Switch the fixed PagePair Reader interface copy.",
      chinese: "中文",
      english: "English",
      savePreferencesLabel: "Save UI preferences",
      savePreferencesDescription: "Store theme, density, and pane visibility preferences on this device. When off, changes only last for the current session.",
      resetLayoutLabel: "Reset workspace layout",
      resetLayoutDescription: "Restore the outline, notes, and assistant panes.",
      resetLayoutButton: "Reset layout",
    },
    appearance: {
      themeLabel: "Theme",
      themeDescription: "Use Claude-like light mode, dark mode, or the system appearance.",
      themeSystem: "System",
      themeLight: "Light",
      themeDark: "Dark",
      accentLabel: "Accent color",
      accentDescription: "Switch the workspace accent token.",
      accentClay: "Clay",
      accentGraphite: "Graphite",
      accentSage: "Sage",
      pdfBackgroundLabel: "PDF background",
      pdfBackgroundDescription: "Adjust the quiet background behind the document.",
      pdfBackgroundPaper: "Paper",
      pdfBackgroundPlain: "Plain",
      pdfBackgroundSoft: "Soft",
      fontScaleLabel: "Font size",
      fontScaleDescription: "Applies to notes, assistant output, and reading text.",
      fontCompact: "Compact",
      fontDefault: "Default",
      fontLarge: "Large",
      compactModeLabel: "Compact mode",
      compactModeDescription: "Reduce toolbar and pane spacing.",
    },
    agent: {
      sourcePillsLabel: "Show source pills",
      sourcePillsDescription: "Show compact source context above the conversation.",
      pageSuggestionsLabel: "Page-aware suggestions",
      pageSuggestionsDescription: "Generate empty-state prompts from the current page title and concepts.",
      pdfContextFullPageLimitLabel: "Full-context page limit",
      pdfContextFullPageLimitDescription: "When the PDF is at or below this page count, send all extractable page text to the model.",
      pdfContextEdgePageCountLabel: "Long-PDF edge pages",
      pdfContextEdgePageCountDescription: "When the PDF exceeds the limit, include this many pages from both the beginning and the end.",
    },
    pdf: {
      scrollbarLabel: "Scrollbar style",
      scrollbarDescription: "Applies to workspace scroll containers.",
      scrollbarThin: "Thin",
      scrollbarSubtle: "Subtle",
      scrollbarNative: "Native",
      summaryHintLabel: "Show page summary hint",
      summaryHintDescription: "Show quiet source context below the document.",
    },
    account: {
      oauthStatusLabel: "OAuth status",
      oauthStatusDescription: "OpenAI Gateway connection status.",
      connectedEmailLabel: "Connected email",
      connectedEmailDescription: "Shown only here, not in the main status bar.",
      providerStatusLabel: "Provider status",
      reconnectLabel: "Reconnect / sign out",
      reconnectDescription: "Reuses the existing OAuth start/logout flow.",
      disconnectButton: "Sign out",
      connectButton: "Connect OpenAI",
      notConnected: "Not connected",
      statuses: {
        connected: "Connected",
        polling: "Waiting for device code",
        offline: "Backend offline",
        mock: "Local preview",
        ready: "Ready to connect",
        unknown: "Checking",
      },
    },
    storage: {
      saveStateLabel: "Save status",
      saveStateDescription: "Local autosave state for the current workspace.",
      workspaceCountLabel: "Workspaces",
      workspaceCountDescription: "Workspaces stored in this browser's IndexedDB.",
      documentCountLabel: "Documents",
      documentCountDescription: "Saved PDF / PagePair documents on this device.",
      usageLabel: "Local usage",
      usageDescription: "Browser estimate across IndexedDB, Cache, and site storage.",
      persistentLabel: "Persistent storage",
      persistentDescription: "Ask the browser not to evict local drafts under storage pressure.",
      persistentRequestButton: "Enable persistence",
      exportLabel: "Export current workspace",
      exportDescription: "Export metadata, chat, notes, and the PDF Blob for backup.",
      exportButton: "Export",
      importLabel: "Import workspace",
      importDescription: "Import a PagePair workspace backup and open it.",
      importButton: "Import",
      clearLabel: "Clear current workspace",
      clearDescription: "Delete the current workspace's PDF, notes, chat, and selections. This cannot be undone.",
      clearButton: "Clear",
      repairLabel: "Check and repair storage",
      repairDescription: "Remove orphan blobs, unreferenced messages, and broken references; documents with missing PDF blobs are marked missing.",
      repairButton: "Repair",
      resetLabel: "Reset current workspace",
      resetDescription: "Return to the initial sample state while keeping global UI preferences.",
      resetButton: "Reset",
      persisted: "Enabled",
      bestEffort: "Standard storage",
      unsupported: "Unsupported",
      unknown: "Unknown",
      noWorkspace: "No workspace yet",
    },
    confirm: {
      cancel: "Cancel",
      clearWorkspaceTitle: "Clear current workspace?",
      clearWorkspaceDescription: "This deletes the current PDF, generated notes, chat, and selected context. This action cannot be undone.",
      clearWorkspaceConfirm: "Clear",
      resetWorkspaceTitle: "Reset current workspace?",
      resetWorkspaceDescription: "This removes the current workspace and returns to the initial sample state. Saved PDFs, notes, and chat will be deleted.",
      resetWorkspaceConfirm: "Reset",
      disconnectTitle: "Disconnect OpenAI OAuth?",
      disconnectDescription: "New AI requests cannot use this OAuth session until you connect again.",
      disconnectConfirm: "Disconnect",
      resetPreferencesTitle: "Reset local UI preferences?",
      resetPreferencesDescription: "This only restores theme, layout, and interface preferences. It does not delete PDFs, notes, or chat.",
      resetPreferencesConfirm: "Reset preferences",
    },
    advanced: {
      debugLabel: "Debug mode",
      debugDescription: "Show task status and diagnostics in the quiet footer.",
      clearPreferencesLabel: "Clear local UI preferences",
      clearPreferencesDescription: "Reset only local visual preferences.",
      clearPreferencesButton: "Reset preferences",
      diagnosticsLabel: "Developer diagnostics",
      diagnosticsHiddenDescription: "Enable Debug mode to show runtime status.",
      visible: "Visible",
      hidden: "Hidden",
    },
  },
  status: {
    localPrototype: "Local prototype",
    preferencesReset: "Local UI settings reset",
    noSelection: "No page selection is available to add",
    selectionAdded: "Selected content added to the conversation",
    explainingSelection: "Explaining selected content",
    summarizingSelection: "Summarizing selected content",
    codeCopied: (code) => `Authorization code ${code} copied`,
    enterCode: (code) => `Enter authorization code ${code} on the OpenAI page`,
    oauthCanceled: "OAuth sign-in canceled",
    oauthDisconnected: "OAuth session disconnected",
    codeShown: (code) => `Authorization code ${code} is shown. Copy it, then open the authorization page.`,
    codeExpired: "OAuth authorization code expired",
    oauthConnected: "OAuth connected",
    oauthBackendMock: "OAuth backend is offline. Switched to static preview mode.",
    jsonImported: "Imported PagePair JSON",
    layoutReset: "Workspace layout reset",
    generationQueued: "Generation task sent to the backend harness",
  },
  errors: {
    accountNotFound: "Connect OpenAI OAuth before sending.",
    jsonNeedsPages: "JSON must contain a pages array",
    emptyGatewayResult: "AI gateway returned an empty result",
    generationStopped: "Generation stopped",
    imageReadFailed: "Failed to read image",
    importedDocument: "Imported document",
    importedPageTitle: (index) => `Page ${index + 1} notes`,
  },
  auth: {
    gatewayConnected: (account) => `OpenAI Gateway: OAuth session connected${account ? ` · ${account}` : ""}`,
    gatewayWaiting: "OpenAI Gateway: waiting for authorization",
    gatewayOffline: "OpenAI Gateway: backend offline",
    gatewayDisconnected: "OpenAI Gateway: disconnected",
    connectionConnected: "OAuth connected",
    connectionWaiting: "Waiting for code",
    connectionLocal: "Local preview",
    connectionReady: "Gateway ready",
  },
  persistence: {
    saving: "Saving...",
    saved: "Saved",
    failed: "Save failed, click to retry",
    quota: "Storage is full",
    localDraft: "Local draft",
    restored: "Restored local workspace",
    pdfMissing: "PDF file is missing; metadata restored",
    restoreFailed: "Failed to restore workspace",
    retrySave: "Retry save",
    saveStatusLabel: "Save status",
    uploadSaved: "PDF saved locally",
    workspaceCleared: "Local workspace cleared",
    workspaceExported: "Workspace exported",
    workspaceImported: "Workspace imported",
    persistentEnabled: "Persistent storage enabled",
    persistentUnavailable: "Persistent storage was not granted; local save still works",
    storageRepaired: (count) => `Storage check completed, handled ${count} invalid records`,
  },
  topbar: {
    resizeHandle: "Resize pane width",
    layoutSwitcherAria: "Workspace layout",
    restoreWorkbench: "Restore full workspace",
    hideRail: "Hide outline",
    showRail: "Show outline",
    hideNotes: "Hide notes pane",
    showNotes: "Show notes pane",
    hideAgent: "Hide assistant",
    showAgent: "Show assistant",
    exitPdfFocus: "Exit PDF focus",
    pdfOnly: "PDF only",
    uploadPdf: "Upload PDF",
    openSettings: "Open settings",
    moreActions: "More actions",
    viewOpenAiCode: "View OpenAI verification code",
    connectOpenAi: "Connect OpenAI OAuth",
    importJson: "Import PagePair JSON",
    exportJson: "Export JSON",
    advancedSettings: "Advanced settings",
    generate: "Generate",
    pageProgressAria: "Page progress",
  },
  rail: {
    searchPlaceholder: "Search documents / PDFs",
    documents: "Documents",
    currentWorkspace: "Current workspace",
    uploadDocument: "Upload PDF",
    emptyDocuments: "No matching documents",
    activeDocument: "Active",
    missingFile: "Missing file",
    documentCount: (count) => `${count} ${count === 1 ? "document" : "documents"}`,
    documentMeta: (pageCount, generatedCount) => `${pageCount} ${pageCount === 1 ? "page" : "pages"} · ${generatedCount} generated`,
    currentPage: (pageNo) => `Last page ${pageNo}`,
  },
  pdf: {
    samplePdfPage: "Sample PDF page",
    previousPage: "Previous page",
    nextPage: "Next page",
    previewTitle: "PDF preview",
    renderFailed: "PDF page rendering failed. Falling back to browser preview.",
    loading: "Loading PDF page",
  },
  notes: {
    title: "Structured Notes",
    tabNotes: "Notes",
    tabStructure: "Structure",
    tabJson: "JSON",
  },
  agent: {
    addImage: "Add image",
    clearContext: "Clear context",
    newConversation: "New chat",
    removeContext: "Remove context",
    removeImage: "Remove image",
    contextFormula: (pageNo) => `Formula · PDF p.${pageNo}`,
    contextSelection: (pageNo) => `Selection · PDF p.${pageNo}`,
    contextPdfReference: (pageNo) => `PDF source · p.${pageNo}`,
    contextSource: (pageNo, source) => `Source PDF p.${pageNo} · ${source}`,
    selectedPdfPage: (pageNo) => `Source PDF p.${pageNo}`,
    selectedNotesPage: (pageNo) => `Notes p.${pageNo}`,
    assistantMessage: "Assistant message",
    pageSource: (pageNo) => `Page p.${pageNo}`,
    imagePreview: (name) => `Image · ${name}`,
    selectedFallbackSuggestions: ["Explain the core idea of this page", "Summarize the key points", "Teach this page with an example", "Quiz me on this page"],
    pageSuggestions: () => ["Explain the core idea of this page", "Summarize the key points", "Teach this page with an example", "Quiz me on this page"],
    quickExplainPrompt: (label) => `Please explain this selected content. Prioritize answering from this source: ${label}`,
    quickSummarizePrompt: (label) => `Please summarize this selected content, extracting key concepts and possible formula relationships: ${label}`,
    continuePrompt: "Please continue based on the context.",
    localPreviewIntro: "Local preview reply: real answers are sent through the backend `/api/agent/chat` endpoint using OpenAI OAuth.",
    localPreviewSelected: (title) => `Read selected content: ${title}.`,
    localPreviewContexts: (count) => `Read ${count} context ${count === 1 ? "item" : "items"}.`,
    localPreviewPage: (pageNo) => `Read page ${pageNo}.`,
    localPreviewImages: (count) => `Also included ${count} ${count === 1 ? "image" : "images"}.`,
    localPreviewQuestion: (question) => `Your question: ${question}`,
    selectionSources: {
      pdfPage: "PDF page selection",
      notes: "Notes selection",
      assistant: "Assistant message selection",
      rail: "Outline selection",
      page: "Page selection",
    },
    askCurrentPage: "Ask About This Page",
    quoteLabel: "Selected content",
    edit: "Edit",
    generationStopped: "Generation stopped",
    generationFailed: "Generation failed. Try again.",
    copy: "Copy",
    regenerate: "Regenerate",
    askWithSelectionPlaceholder: "Ask about the selected content",
    askPlaceholder: "Ask about the current page or selected content",
    inputAria: "Assistant input",
    formulaTitle: "Math formula",
    stop: "Stop",
    send: "Send",
    thinking: "Thinking with the current context",
    removeSelectedContent: "Remove selected content",
    selectionToolbarAria: "Selected content actions",
    addToConversation: "Add to conversation",
    explainSelection: "Explain selection",
    summarizeSelection: "Summarize selection",
  },
  oauth: {
    kicker: "OpenAI Codex sign-in",
    title: "Enter the 9-character code requested by the web page",
    cancel: "Cancel OAuth sign-in",
    codeAria: (code) => `Authorization code ${code}`,
    copied: "Copied",
    copyCode: "Copy code",
    openAuthPage: "Open authorization page",
    expiresIn: (time) => `Expires in ${time}`,
  },
  structure: {
    pageNo: "Page",
    parser: "Parser",
    ocr: "OCR",
    confidence: "Alignment confidence",
    prerequisites: "Prerequisites",
    visualNotes: "Visual notes",
    sourceText: "Source text",
    ocrEnabled: "Enabled",
    ocrDisabled: "Disabled",
  },
};

export const appCopy: Record<Language, AppCopy> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export function getAppCopy(language: Language) {
  return appCopy[language] || appCopy["zh-CN"];
}
