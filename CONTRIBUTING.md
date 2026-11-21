# Contributing / 貢獻指南

歡迎 PR 與 issue！ PRs and issues are welcome.

## 開發 / Development

```bash
git clone https://github.com/ckolpeter/clausage.git
cd clausage
npm install
npm start
npm test     # 單元測試 / unit tests (no Electron needed)
```

- `src/main.js` — main process：視窗、系統匣、資料抓取、設定
- `src/usage.js` — 解析 claude.ai 回應、預測用完時間（純函式，有單元測試）
- `src/history.js` / `src/code-stats.js` / `src/updater.js` / `src/fullscreen.js` — 用量紀錄、Claude Code 統計、自動更新、全螢幕偵測
- `test/` — `node --test` 單元測試；`test/fixtures/` 放 claude.ai 實際回應格式（不含個資）
- `src/preload.js` — contextBridge，renderer 唯一能呼叫的 API
- `src/widget.*` / `src/settings.*` — UI（無框架，純 HTML/JS）

## 翻譯 / Translations

介面文字都在 `src/locales/*.json`。新增語言 / To add a language：

1. 複製 `src/locales/en.json`，檔名用語言代碼，例如 `ja.json`、`zh-CN.json`、`ko.json`
2. 把 `_name` 改成該語言的自稱（例如 `日本語`），翻譯所有值；`{變數}` 保持原樣
3. `npm start`，右鍵小工具 → Language 選擇新語言確認顯示正常
4. 發 PR

缺少的 key 會自動使用英文。Missing keys fall back to English.

## 原則 / Principles

1. **隱私優先**：登入資料只能送往 `claude.ai` / `api.anthropic.com`，不得加入任何遙測或第三方服務。
2. **對 Anthropic 友善**：預設更新間隔不得低於 60 秒，最少 30 秒。
3. **安全預設**：維持 `contextIsolation: true`、`sandbox: true`，renderer 不可直接存取 Node。
4. **零框架**：UI 保持輕量，新增相依套件前請先開 issue 討論。

## 發佈 / Releasing（維護者）

```bash
npm version patch   # 或 minor / major，會建立 vX.Y.Z 標籤
git push --follow-tags
```

GitHub Actions 會在三個平台建置並建立 Release 草稿，確認後按 Publish。
